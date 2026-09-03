// src/lib/agent-deploy-guard.ts
//
// SUBTASK F — AGENT DEPLOY COST CONTROL
//
// Smallest existing-compatible protection for POST /api/agent/deploy, which
// provisions Circle wallets + an on-chain register with no visible
// quota/rate-limit/idempotency protection. This module is intentionally
// dependency-free (no next/server, no prisma, no Redis client) so it can be
// imported from the route handler, edge runtimes, and plain-node tests.
//
// Invariants honoured:
// - Keyed by the AUTHENTICATED merchant (merchant_token session / API key
//   resolved via withMerchantAuth). Empty/unknown merchant is REFUSED —
//   there is deliberately no default-payer fallback here.
// - This guard NEVER touches Circle wallets: it holds no wallet references
//   and exposes no delete path, so it cannot orphan wallets. On failure the
//   caller may only release the in-memory idempotency claim (see below).
// - No "max 1 agent" quota: distinct idempotency keys always allow
//   legitimate multiple-agent provisioning up to the per-minute budget.
//
// Relationship to existing infra (read-only reuse, nothing edited):
// - Limits mirror RATE_LIMITS.agent in src/lib/ratelimit.ts (10/min). That
//   helper keys by API key / connection IP, which is wrong for a
//   merchant-scoped deploy gate, so its values/patterns are mirrored here
//   (fixed window + bounded in-memory fallback store, cf. H12) rather than
//   imported — importing it would also drag next/server into this module.
// - Idempotency-key normalisation (trim, 120-char cap) follows the
//   convention in src/lib/agents/agentPay.ts.
//
// ── WIRING (for the parent / Subtask E — DO NOT edit the deploy route here)
// Paste AFTER withMerchantAuth resolves `merchant`, BEFORE any Circle call:
//
//   import { checkAgentDeployAllowed } from "@/src/lib/agent-deploy-guard";
//
//   const idemKey =
//     typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined;
//   const gate = checkAgentDeployAllowed(merchant.id, idemKey);
//   if (!gate.allowed) {
//     if (gate.reason === "duplicate") {
//       return NextResponse.json(
//         { success: false, error: "Duplicate agent deploy — replay of an in-progress request.", replayed: true },
//         { status: 409 }
//       );
//     }
//     return NextResponse.json(
//       { success: false, error: "Agent deploy throttled — slow down and retry.", retryAfterMs: gate.retryAfterMs ?? null },
//       { status: 429, headers: gate.retryAfterMs ? { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } : undefined }
//     );
//   }
//   // ... provision Circle wallets + on-chain register as today ...
//   // On terminal failure BEFORE funds move, optionally free the key so the
//   // client can retry with the same key (never deletes wallets):
//   //   releaseAgentDeployClaim(merchant.id, idemKey);

export type AgentDeployGuardReason =
  | "ok"
  | "duplicate"
  | "rate-limited"
  | "throttled"
  | "unauthenticated";

export interface AgentDeployGuardResult {
  allowed: boolean;
  reason: AgentDeployGuardReason;
  /** Milliseconds until the caller may retry (429-style outcomes only). */
  retryAfterMs?: number;
  /** True when this is a replay of a previously seen idempotency key. */
  replay?: boolean;
  /** Deploys remaining in the current per-merchant window (allow outcome). */
  remaining?: number;
}

export interface AgentDeployGuardOptions {
  /** Override for tests/ops. Defaults mirror RATE_LIMITS.agent (10/min). */
  maxPerWindow?: number;
  windowMs?: number;
  /** Keyless repeats inside this interval look like accidental double-submits. */
  minIntervalMs?: number;
  now?: number;
}

// Mirrors RATE_LIMITS.agent in src/lib/ratelimit.ts — keep in sync by hand
// (importing that module would couple this guard to next/server).
const DEFAULT_MAX_PER_WINDOW = 10;
const DEFAULT_WINDOW_MS = 60_000;
// Burst throttle for KEYLESS repeats only: a second deploy within this
// interval without an idempotency key is treated as an accidental
// double-submit. Callers provisioning several agents pass a distinct
// idempotencyKey per deploy, which always bypasses this burst check.
const DEFAULT_MIN_INTERVAL_MS = 5_000;
// Idempotency claims live long enough to dedupe client retries, then expire.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
// Bounded stores (same H12 rationale as src/lib/ratelimit.ts): caps keep a
// flood of distinct merchant/key values from growing memory without bound.
const MAX_RATE_ENTRIES = 10_000;
const MAX_IDEMPOTENCY_ENTRIES = 5_000;

interface RateRecord {
  count: number;
  windowStart: number;
  lastAllowedAt: number;
}

interface IdempotencyRecord {
  claimedAt: number;
}

const rateStore = new Map<string, RateRecord>();
const idempotencyStore = new Map<string, IdempotencyRecord>();

function pruneStore<K, V>(store: Map<K, V>, max: number): void {
  while (store.size > max) {
    const oldest = store.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function normalizeAgentDeployMerchantId(merchantId: unknown): string {
  return typeof merchantId === "string" ? merchantId.trim() : "";
}

export function normalizeAgentDeployIdempotencyKey(key: unknown): string {
  // Same convention as agentPay.ts: trim + 120-char cap.
  return typeof key === "string" ? key.trim().slice(0, 120) : "";
}

/**
 * Merchant-scoped deploy gate: per-minute rate limit + idempotency-key
 * dedupe + burst throttle for keyless accidental repeats.
 *
 * Returns allow by default — only abusive shapes are denied. A granted call
 * with an idempotency key claims that key (merchant-scoped) so replays
 * dedupe; a granted keyless call only consumes rate budget.
 */
export function checkAgentDeployAllowed(
  merchantId: string,
  idempotencyKey?: string | null,
  options?: AgentDeployGuardOptions
): AgentDeployGuardResult {
  const merchant = normalizeAgentDeployMerchantId(merchantId);
  if (!merchant) {
    // No default-payer fallback: refuse instead of attributing to anyone.
    return { allowed: false, reason: "unauthenticated" };
  }
  const key = normalizeAgentDeployIdempotencyKey(idempotencyKey);
  const now = options?.now ?? Date.now();
  const maxPerWindow = options?.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  // 1. Idempotency replay: same merchant + same key → dedupe, no re-provision.
  //    Checked first so replays never burn rate budget.
  if (key) {
    const claimKey = `${merchant}:${key}`;
    const claim = idempotencyStore.get(claimKey);
    if (claim && now - claim.claimedAt < IDEMPOTENCY_TTL_MS) {
      return { allowed: false, reason: "duplicate", replay: true };
    }
    if (claim) idempotencyStore.delete(claimKey); // expired — reclaim below
  }

  // 2. Per-merchant fixed-window rate limit.
  let record = rateStore.get(merchant);
  if (!record || now - record.windowStart >= windowMs) {
    record = { count: 0, windowStart: now, lastAllowedAt: 0 };
    rateStore.set(merchant, record);
    pruneStore(rateStore, MAX_RATE_ENTRIES);
  }
  if (record.count >= maxPerWindow) {
    return {
      allowed: false,
      reason: "rate-limited",
      retryAfterMs: record.windowStart + windowMs - now,
    };
  }

  // 3. Burst throttle: keyless repeat inside minIntervalMs is presumed an
  //    accidental double-submit (double-click / retry storm). A fresh
  //    idempotency key proves distinct intent and bypasses this check, so
  //    legitimate back-to-back multi-agent provisioning is preserved.
  if (!key && record.lastAllowedAt > 0 && now - record.lastAllowedAt < minIntervalMs) {
    return {
      allowed: false,
      reason: "throttled",
      retryAfterMs: record.lastAllowedAt + minIntervalMs - now,
    };
  }

  // 4. Allow: consume budget, stamp activity, claim the idempotency key.
  record.count += 1;
  record.lastAllowedAt = now;
  if (key) {
    idempotencyStore.set(`${merchant}:${key}`, { claimedAt: now });
    pruneStore(idempotencyStore, MAX_IDEMPOTENCY_ENTRIES);
  }
  return { allowed: true, reason: "ok", remaining: maxPerWindow - record.count };
}

/**
 * Release an idempotency claim so the client may retry with the same key
 * (e.g. terminal deploy failure before any funds moved). This ONLY forgets
 * the in-memory claim — it never touches Circle wallets and cannot orphan
 * them; the guard holds no wallet references at all.
 */
export function releaseAgentDeployClaim(
  merchantId: string,
  idempotencyKey?: string | null
): boolean {
  const merchant = normalizeAgentDeployMerchantId(merchantId);
  const key = normalizeAgentDeployIdempotencyKey(idempotencyKey);
  if (!merchant || !key) return false;
  return idempotencyStore.delete(`${merchant}:${key}`);
}

/** Test/ops reset for the in-memory guard state. Not used by the route. */
export function resetAgentDeployGuard(): void {
  rateStore.clear();
  idempotencyStore.clear();
}
