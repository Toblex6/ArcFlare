// src/lib/agents/agentLifecycle.ts
//
// Owner-facing Agent lifecycle composition (Deploy → Wallet → Identity →
// Active → Serviceable → Discoverable → Economic Activity → Reputation).
//
// This is a LIFECYCLE-COMPOSITION module: it derives display state ONLY from
// facts the existing backends already return. It introduces no new status
// enum, no new accounting, no trust recalculation, and no second
// serviceability rule:
//
// - serviceability === the hire-route gate (`status ===
//   ACTIVE_AGENT_PROVISIONED`), reused via `agentIsServiceable` — never
//   re-derived here. The UI must never imply "ready to hire" when that gate
//   would reject, so `serviceable` in the result is the single hire-readiness
//   signal consumers must use.
// - trust/reputation are display-only views (`trustView`, `reputationView`)
//   over backend-supplied payloads — never synthesized.
// - identifiers reuse `agentIdentifierRows` (Registry ID vs ERC-8004 token ID
//   vs SCA are never merged into one "Agent ID").
// - economics input is an already-fetched ledger/treasury summary — when it
//   was never loaded the stage reports `unknown`, never "no activity".
//
// Every function is pure (no network, no Prisma, no next/server) and total:
// malformed input yields honest `unknown` stages, never a throw.

import {
  SERVICEABLE_STATUS,
  agentIsServiceable,
  humanStatusLabel,
  trustView,
  reputationView,
  agentIdentifierRows,
  type IdentifierRow,
} from "@/lib/discovery/consumerDiscovery";

export { SERVICEABLE_STATUS };

export type LifecycleStageState = "ready" | "attention" | "unknown";

export interface LifecycleStage {
  key: "wallet" | "identity" | "serviceability" | "discoverability" | "economics" | "trust";
  label: string;
  state: LifecycleStageState;
  /** One honest line grounded in the backend fact behind this stage. */
  detail: string;
}

export type NextActionKind =
  | "recover-deployment"
  | "setup-wallet"
  | "complete-identity"
  | "inspect-status"
  | "drive-activity"
  | "manage";

export interface OwnerNextAction {
  kind: NextActionKind;
  /** Button label for the single primary owner action. */
  label: string;
  /** Existing Agent Hub tab that fulfils the action (no new flows). */
  targetTab: "deploy" | "registry" | "reputation" | "validation" | "economics" | "trust";
  /** Honest one-liner explaining why this is next. */
  hint: string;
}

export interface LifecycleEconomicsInput {
  /** Number of ledger entries (treasury `entryCount`). */
  entryCount?: unknown;
  /** Lifetime revenue in micro-USDC (treasury `revenue`), string or number. */
  revenue?: unknown;
  /** Jobs completed as provider (track-record `stats.completedJobs`). */
  completedJobs?: unknown;
}

export interface DeployIntentInput {
  status?: unknown;
  registerTxHash?: unknown;
}

export interface DeriveLifecycleInput {
  deployIntent?: DeployIntentInput | null;
  /** Already-fetched ledger/treasury summary; null/undefined = not loaded. */
  economics?: LifecycleEconomicsInput | null;
  /** Already-fetched trust payload (`trackRecord.trust`); null = not loaded. */
  trust?: unknown;
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function asCount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

/** Revenue arrives as micro-USDC (6-decimal bigint-safe string). >0 = activity. */
function hasRevenue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  try {
    if (typeof v === "bigint") return v > 0n;
    if (typeof v === "number") return Number.isFinite(v) && v > 0;
    if (typeof v === "string" && v.trim() !== "") return BigInt(v.trim()) > 0n;
  } catch {
    return false;
  }
  return false;
}

export interface OwnerLifecycle {
  stages: LifecycleStage[];
  nextAction: OwnerNextAction;
  /** Mirrors the backend hire gate — the ONLY hire-readiness signal. */
  serviceable: boolean;
  statusLabel: string;
  identifiers: IdentifierRow[];
  /** Present only for troubleshooting/owner management — never a headline ID. */
  walletSetId: string | null;
}

/**
 * Derive the owner-facing lifecycle for one AgentRegistry-shaped record.
 * `agent` is the shape `GET /api/agent/list` already returns (plus optional
 * `walletSetId`/`validatorSca` for troubleshooting). Never throws.
 */
export function deriveOwnerLifecycle(agent: unknown, input?: DeriveLifecycleInput): OwnerLifecycle {
  const fallback = (hint: string): OwnerLifecycle => ({
    stages: (["wallet", "identity", "serviceability", "discoverability", "economics", "trust"] as const).map(
      (key) => ({
        key,
        label: STAGE_LABELS[key],
        state: "unknown" as const,
        detail: hint,
      }),
    ),
    nextAction: {
      kind: "inspect-status",
      label: "Inspect agent status",
      targetTab: "registry",
      hint,
    },
    serviceable: false,
    statusLabel: "Unknown",
    identifiers: [],
    walletSetId: null,
  });

  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return fallback("Agent data is unavailable — reload the registry list.");
  }
  const row = agent as Record<string, unknown>;

  const sca = asNonEmptyString(row.scaAddress);
  const circleWalletId = asNonEmptyString(row.circleWalletId);
  const tokenId =
    row.tokenId !== null && row.tokenId !== undefined ? String(row.tokenId).trim() : "";
  const walletSetId = asNonEmptyString(row.walletSetId);
  const status = typeof row.status === "string" ? row.status : null;

  const serviceable = agentIsServiceable(status);
  const statusLabel = humanStatusLabel(status);

  // ── Wallet readiness ─────────────────────────────────────────────
  // Circle SCA + Circle wallet binding. The validator/hire serviceability
  // checks resolve `circleWalletId` server-side; an SCA without one cannot
  // sign, so it is honestly "setup needed", not ready.
  const walletStage: LifecycleStage =
    sca && circleWalletId
      ? {
          key: "wallet",
          label: STAGE_LABELS.wallet,
          state: "ready",
          detail: "Circle wallet linked — this agent can sign.",
        }
      : sca
        ? {
            key: "wallet",
            label: STAGE_LABELS.wallet,
            state: "attention",
            detail: "SCA exists but no Circle wallet binding — wallet setup needed.",
          }
        : {
            key: "wallet",
            label: STAGE_LABELS.wallet,
            state: "attention",
            detail: "No wallet on record — wallet setup needed.",
          };

  // ── Identity readiness ───────────────────────────────────────────
  // A persisted registry row carries the REAL on-chain ERC-8004 tokenId (the
  // deploy route refuses to persist fallbacks). Missing/blank = incomplete.
  const identityStage: LifecycleStage = tokenId
    ? {
        key: "identity",
        label: STAGE_LABELS.identity,
        state: "ready",
        detail: `ERC-8004 token #${tokenId} minted.`,
      }
    : {
        key: "identity",
        label: STAGE_LABELS.identity,
        state: "attention",
        detail: "Identity incomplete — no ERC-8004 token on record.",
      };

  // ── Serviceability (authoritative gate, reused — never re-derived) ──
  const serviceabilityStage: LifecycleStage = serviceable
    ? {
        key: "serviceability",
        label: STAGE_LABELS.serviceability,
        state: "ready",
        detail: "Serviceable — passes the backend hire gate.",
      }
    : {
        key: "serviceability",
        label: STAGE_LABELS.serviceability,
        state: "attention",
        detail: status
          ? `Not serviceable (status: ${statusLabel}). Hiring would be rejected.`
          : "Not serviceable — hiring would be rejected.",
      };

  // ── Discoverability ──────────────────────────────────────────────
  // The discover + card routes serve exactly the serviceable set, so
  // discoverability follows the same gate. No separate probe is claimed.
  const discoverabilityStage: LifecycleStage = serviceable
    ? {
        key: "discoverability",
        label: STAGE_LABELS.discoverability,
        state: "ready",
        detail: "Discoverable via marketplace search and agent card.",
      }
    : {
        key: "discoverability",
        label: STAGE_LABELS.discoverability,
        state: "attention",
        detail: "Hidden from discovery until serviceable.",
      };

  // ── Economic activity (loaded summaries only — never invented) ────
  const eco = input?.economics ?? null;
  let economicsStage: LifecycleStage;
  let hasActivity = false;
  if (!eco || typeof eco !== "object") {
    economicsStage = {
      key: "economics",
      label: STAGE_LABELS.economics,
      state: "unknown",
      detail: "Economic activity not loaded yet — open Economics for this agent.",
    };
  } else {
    const entries = asCount((eco as LifecycleEconomicsInput).entryCount);
    const completed = asCount((eco as LifecycleEconomicsInput).completedJobs);
    const revenue = hasRevenue((eco as LifecycleEconomicsInput).revenue);
    hasActivity = (entries !== null && entries > 0) || (completed !== null && completed > 0) || revenue;
    economicsStage = hasActivity
      ? {
          key: "economics",
          label: STAGE_LABELS.economics,
          state: "ready",
          detail:
            entries !== null && entries > 0
              ? `${entries} ledger ${entries === 1 ? "entry" : "entries"} on record.`
              : "On-chain economic activity on record.",
        }
      : {
          key: "economics",
          label: STAGE_LABELS.economics,
          state: "attention",
          detail: "No ledger/jobs activity recorded yet.",
        };
  }

  // ── Trust / reputation (display-only views over backend payloads) ──
  const trust = trustView(input?.trust);
  const dbRep = reputationView(row.reputation);
  let trustStage: LifecycleStage;
  if (trust.present) {
    trustStage = {
      key: "trust",
      label: STAGE_LABELS.trust,
      state: "ready",
      detail:
        trust.confidence !== null
          ? `Trust ${trust.score}/100 · confidence ${trust.confidence}.`
          : `Trust ${trust.score}/100.`,
    };
  } else if (dbRep.present) {
    trustStage = {
      key: "trust",
      label: STAGE_LABELS.trust,
      state: "ready",
      detail: `Reputation ${dbRep.score}/100 on record (no computed trust loaded).`,
    };
  } else {
    trustStage = {
      key: "trust",
      label: STAGE_LABELS.trust,
      state: "unknown",
      detail: "No trust/reputation data loaded yet — open Trust for this agent.",
    };
  }

  const stages = [walletStage, identityStage, serviceabilityStage, discoverabilityStage, economicsStage, trustStage];

  // ── Next action (strict priority — first provable need wins) ──────
  const intentStatus =
    input?.deployIntent && typeof input.deployIntent === "object"
      ? String((input.deployIntent as DeployIntentInput).status ?? "").toUpperCase()
      : "";
  const intentTx =
    input?.deployIntent && typeof input.deployIntent === "object"
      ? asNonEmptyString((input.deployIntent as DeployIntentInput).registerTxHash)
      : null;

  let nextAction: OwnerNextAction;
  if (intentStatus === "PENDING_IDENTITY_CONFIRMATION") {
    nextAction = {
      kind: "recover-deployment",
      label: "Recover pending identity",
      targetTab: "deploy",
      hint: intentTx
        ? `On-chain registration ${intentTx.slice(0, 14)}… confirmed but the token was not indexed — recover it instead of redeploying.`
        : "A deployment is waiting on identity confirmation — recover it instead of redeploying.",
    };
  } else if (!sca || !circleWalletId) {
    // There is no "link wallet" endpoint: Circle wallets are provisioned by
    // the deploy flow itself, so the honest recovery path is redeployment
    // (which provisions a fresh wallet set) — never a fake local fix.
    nextAction = {
      kind: "setup-wallet",
      label: "Set up wallet",
      targetTab: "deploy",
      hint: "No Circle wallet binding on record — re-run deployment to provision the wallet set.",
    };
  } else if (!tokenId) {
    nextAction = {
      kind: "complete-identity",
      label: "Complete identity",
      targetTab: "deploy",
      hint: "Finish the ERC-8004 registration (recover a pending tx, or redeploy).",
    };
  } else if (!serviceable) {
    nextAction = {
      kind: "inspect-status",
      label: "Inspect agent status",
      targetTab: "registry",
      hint: `Status is ${statusLabel} — hiring would be rejected until it is ${SERVICEABLE_STATUS}.`,
    };
  } else if (eco && typeof eco === "object" && !hasActivity) {
    nextAction = {
      kind: "drive-activity",
      label: "Get first job",
      targetTab: "economics",
      hint: "Serviceable and discoverable — next is real economic activity (hire flow, marketplace listing).",
    };
  } else {
    nextAction = {
      kind: "manage",
      label: "Manage agent",
      targetTab: "registry",
      hint: "Active and serviceable — reputation, validation, economics and trust from here.",
    };
  }

  return {
    stages,
    nextAction,
    serviceable,
    statusLabel,
    identifiers: agentIdentifierRows({ id: row.id, tokenId: tokenId || undefined, scaAddress: sca ?? undefined }),
    walletSetId,
  };
}

const STAGE_LABELS: Record<LifecycleStage["key"], string> = {
  wallet: "Wallet",
  identity: "Identity",
  serviceability: "Serviceability",
  discoverability: "Discoverability",
  economics: "Economic activity",
  trust: "Trust / reputation",
};

// ── Deployment controls ──────────────────────────────────────────────
// The backend duplicate guard (in-memory idempotency claims + persisted
// deploy-intent uniqueness) is authoritative. These helpers only shape the
// single primary setup control so double-submits are obviously pointless:
// the button disables while a deploy is in flight, every attempt carries a
// fresh idempotency key the guard can dedupe, and a 409 surfaces the
// recovery path instead of a dead end. No client-side lock ever replaces
// the server guard.

export interface DeployControlInput {
  deploying: boolean;
  /** Raw error string from the last deploy attempt, if any. */
  lastError?: string | null;
  /** True when the last attempt returned HTTP 409 (guard replay). */
  lastWasDuplicate?: boolean;
  /** True when a recoverable pending-identity response was returned. */
  lastWasPending?: boolean;
}

export interface DeployControlView {
  disabled: boolean;
  label: string;
  /** Honest helper line under the button (empty when nothing to explain). */
  hint: string;
}

export function deployControlView(input: DeployControlInput): DeployControlView {
  if (input.deploying) {
    return {
      disabled: true,
      label: "Deploying to Arc Testnet…",
      hint: "Deploy in progress — double-submits are blocked server-side by the idempotency guard.",
    };
  }
  if (input.lastWasDuplicate) {
    return {
      disabled: false,
      label: "Deploy agent",
      hint:
        "The server blocked a duplicate deploy for that idempotency key. Check the registry — or recover the pending transaction instead of redeploying.",
    };
  }
  if (input.lastWasPending) {
    return {
      disabled: false,
      label: "Deploy agent",
      hint: "Last attempt left a pending identity — recover it via POST /api/agent/deploy/recover with the txHash.",
    };
  }
  return { disabled: false, label: "Deploy agent", hint: "" };
}

/** Fresh idempotency key per deploy attempt (backend guard dedupes replays). */
export function newDeployIdempotencyKey(): string {
  try {
    const c = (globalThis as Record<string, unknown>).crypto as
      | { randomUUID?: () => string }
      | undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    // fall through to the Math.random fallback below
  }
  return `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Classify a deploy HTTP result for `deployControlView` without touching the
 * backend guard: 409 = guard replay, 502-with-pending-status = recoverable.
 */
export function classifyDeployResult(status: number, body: unknown): {
  duplicate: boolean;
  pending: boolean;
} {
  if (status === 409) return { duplicate: true, pending: false };
  const s =
    body && typeof body === "object"
      ? String((body as Record<string, unknown>).status ?? "").toUpperCase()
      : "";
  return { duplicate: false, pending: s === "PENDING_IDENTITY_CONFIRMATION" };
}
