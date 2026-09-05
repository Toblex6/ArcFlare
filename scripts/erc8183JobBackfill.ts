// scripts/erc8183JobBackfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure, side-effect-free core for the idempotent PRE-TRACK-3 Direct-Hire job
// backfill (see scripts/backfill-erc8183-jobs.ts for the CLI wiring).
//
// GOAL: safely reconstruct a canonical `Erc8183Job` row for a historical
// Direct-Hire job that exists on-chain but never got an Erc8183Job row.
//
// WHY THIS IS SAFE:
//   The pre-Track-3 flat Direct-Hire create path (verified at commit e85e55a^)
//   minted an on-chain ERC-8183 job AND wrote a legacy `Job` mirror with
//     id      = `erc8183_${onChainJobId}`
//     agentId = providerSCA (the provider address)
//     description = the same string passed to createJob
//   That encoded id is a reliable legacy→chain linkage, and the description /
//   provider give two independent cross-checks that the legacy row and the
//   on-chain job are the SAME job — without trusting anything the caller typed.
//
// PROVENANCE PER FIELD (never guessed; each REQUIRED field is authoritative):
//   jobId        ← on-chain getJob().id, cross-verified vs the `erc8183_<n>` id
//   clientSCA    ← on-chain getJob().client
//   providerSCA  ← on-chain getJob().provider (cross-checked vs legacy agentId)
//   evaluatorSCA ← on-chain getJob().evaluator (falls back to client if 0x0,
//                  exactly mirroring createJob's `evaluatorSCA || clientSCA`)
//   description  ← on-chain getJob().description (cross-checked vs legacy)
//   budget       ← on-chain getJob().budget
//   status       ← on-chain getJob().status mapped 0..5 (never inferred)
//   expiredAt    ← on-chain getJob().expiredAt (unix → Date)
//   hook         ← on-chain getJob().hook
//   createdAt    ← legacy Job.createdAt (creation-time DB timestamp; timeline)
//   merchantId   ← legacy Job.merchantId when present, else null
//   agentId      ← CANNOT be reliably reconstructed (legacy stored the provider
//                  ADDRESS here, not an Agent.id) → always null
//   deliverableHash/reasonHash ← only derivable from chain submit/complete
//                  events; left null (a valid DB state) — never fabricated
//   txHashes     ← from the chain JobCreated event; empty [] when not resolved
//                  (valid DB state; lifecycle appends)
//
// HARD GATES (skip + report — never guess):
//   * id does not parse to a valid on-chain jobId            → ambiguous
//   * on-chain job id != requested job id                    → ambiguous
//   * on-chain status not in 0..5                            → ambiguous
//   * legacy description (if present) != on-chain description→ mismatch
//   * legacy agentId (if present) != on-chain provider       → mismatch
//   * Erc8183Job already exists for the id                   → already-backfilled
//   * no on-chain job / read inconclusive                    → missing-on-chain
//
// IDEMPOTENCY: findUnique-equivalent check first; never overwrites; a single
// unique jobId can be created at most once per run (in-run dedupe) and across
// runs the same guard + DB unique constraint prevent duplicates.
//
// This module performs NO I/O. All I/O (chain reads, DB reads/writes) is
// injected so the behavior can be proven with mocks in
// scripts/backfill-erc8183-jobs-tests.ts without a network or database.
// ─────────────────────────────────────────────────────────────────────────────

export interface LegacyJobRow {
  id: string; // expected `erc8183_<onChainJobId>`
  description: string;
  amount: number; // create-time Float USDC estimate; NOT authoritative for budget
  status: string;
  agentId: string; // historical direct-hire stored providerSCA here
  merchantId: string | null;
  createdAt: Date;
}

export interface OnChainJob {
  id: bigint;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: bigint;
  expiredAt: bigint; // unix seconds
  status: number; // 0=OPEN 1=FUNDED 2=SUBMITTED 3=COMPLETED 4=REJECTED 5=EXPIRED
  hook: string;
}

export type OnChainResult =
  | { kind: 'exists'; job: OnChainJob }
  | { kind: 'missing' } // getJob reverted / returned a zeroed slot
  | { kind: 'error'; error: string }; // every candidate RPC failed transiently

export interface Erc8183JobCreateData {
  jobId: bigint;
  clientSCA: string;
  providerSCA: string;
  evaluatorSCA: string;
  description: string;
  budget: bigint;
  status: string;
  deliverableHash: string | null;
  reasonHash: string | null;
  txHashes: string[];
  hook: string | null;
  createdAt: Date;
  expiredAt: Date;
  agentId: string | null;
  merchantId: string | null;
}

export type ExistingResolver = (jobId: bigint) => Promise<boolean> | boolean;
export type ChainReader = (jobId: bigint) => Promise<OnChainResult>;
export type Persister = (payload: Erc8183JobCreateData) => Promise<void> | void;

export type SkipReason =
  | 'already-backfilled'
  | 'missing-on-chain'
  | 'ambiguous'
  | 'mismatch'
  | 'rpc-error';

export interface BackfillItem {
  jobId: bigint;
  legacyId: string;
  wouldBackfill: boolean; // true when this is a dry-run (nothing persisted)
  payload?: Erc8183JobCreateData;
}
export interface SkipItem {
  jobId: bigint | null;
  legacyId: string | null;
  reason: SkipReason;
  detail: string;
}
export interface MismatchItem {
  jobId: bigint;
  legacyId: string;
  field: 'description' | 'provider';
  legacyValue: string;
  chainValue: string;
}

export interface BackfillReport {
  discovered: number; // legacy erc8183_* candidates considered
  backfilled: BackfillItem[];
  skipped: SkipItem[];
  mismatch: MismatchItem[];
  noDuplicate: boolean;
}

export interface RunBackfillOptions {
  candidates: LegacyJobRow[];
  existing: ExistingResolver;
  chainRead: ChainReader;
  persist?: Persister; // required unless dryRun
  dryRun: boolean;
}
// ── helpers ──────────────────────────────────────────────────────────────────
const ZERO_ADDR = '0x' + '0'.repeat(40);
export function normalizeAddr(s: string): string {
  return (s || '').trim().toLowerCase();
}
export function isZeroAddr(s: string): boolean {
  return normalizeAddr(s) === ZERO_ADDR;
}

// Maps on-chain status u8 → canonical DB status strings (same table the Track 3
// lifecycle uses). Anything outside 0..5 is treated as unreconstructable.
export const DB_STATUS_BY_ONCHAIN: Record<number, string> = {
  0: 'OPEN',
  1: 'FUNDED',
  2: 'SUBMITTED',
  3: 'COMPLETED',
  4: 'REJECTED',
  5: 'EXPIRED',
};

const LEGACY_ID_RE = /^erc8183_(\d+)$/;

/**
 * Parse a legacy `Job.id` of the form `erc8183_<onChainJobId>` into the on-chain
 * jobId it encodes. Returns null when the id is not a parseable direct-hire
 * mirror (those rows cannot be linked to a chain job and are skipped).
 */
export function parseLegacyJobId(id: string): bigint | null {
  const m = LEGACY_ID_RE.exec((id || '').trim());
  if (!m) return null;
  try {
    const n = BigInt(m[1]);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

/**
 * Build the canonical Erc8183Job creation payload from authoritative on-chain
 * state plus safe legacy timestamp/merchant context. Returns null (with a
 * reason) when a REQUIRED field cannot be proven — never a guess.
 */
export function buildCreatePayload(
  legacy: LegacyJobRow,
  job: OnChainJob
): { ok: true; payload: Erc8183JobCreateData } | { ok: false; reason: string } {
  const status = DB_STATUS_BY_ONCHAIN[job.status];
  if (!status) {
    return { ok: false, reason: `unexpected on-chain status ${job.status} (not in 0..5)` };
  }
  const evaluator = isZeroAddr(job.evaluator) ? job.client : job.evaluator;
  return {
    ok: true,
    payload: {
      jobId: job.id,
      clientSCA: job.client,
      providerSCA: job.provider,
      evaluatorSCA: evaluator,
      description: job.description,
      budget: job.budget,
      status,
      deliverableHash: null,
      reasonHash: null,
      txHashes: [], // chain-event derived; empty is a valid pre-lifecycle state
      hook: isZeroAddr(job.hook) ? null : job.hook,
      createdAt: legacy.createdAt ?? new Date(),
      expiredAt: new Date(Number(job.expiredAt) * 1000),
      agentId: null, // not reconstructable from legacy (was a provider address)
      merchantId: legacy.merchantId ?? null,
    },
  };
}
/**
 * Run the idempotent backfill over the given candidates. Pure — every I/O call
 * goes through the injected `existing` / `chainRead` / `persist` functions.
 *
 * Sequence per candidate:
 *   1. parse legacy id → jobId (else ambiguous)
 *   2. if Erc8183Job already exists (this run or pre-existing) → already-backfilled
 *   3. read on-chain (chainRead) → error / missing / exists
 *   4. cross-check legacy vs chain → mismatch (hard gate)
 *   5. build payload → ambiguous on any unprovable required field
 *   6. create (unless dryRun). In-run dedupe guarantees no duplicate writes.
 */
export async function runBackfill(opts: RunBackfillOptions): Promise<BackfillReport> {
  const report: BackfillReport = {
    discovered: 0,
    backfilled: [],
    skipped: [],
    mismatch: [],
    noDuplicate: true,
  };
  const createdThisRun = new Set<string>(); // jobIds we've already backfilled
  const existingCache = new Map<string, boolean>();

  async function exists(jobId: bigint): Promise<boolean> {
    const k = jobId.toString();
    if (createdThisRun.has(k)) return true;
    if (existingCache.has(k)) return existingCache.get(k)!;
    const v = await opts.existing(jobId);
    existingCache.set(k, v);
    return v;
  }

  for (const legacy of opts.candidates) {
    report.discovered++;
    const jobId = parseLegacyJobId(legacy.id);
    if (jobId === null) {
      report.skipped.push({
        jobId: null,
        legacyId: legacy.id,
        reason: 'ambiguous',
        detail: 'legacy Job.id is not a parseable `erc8183_<n>` direct-hire mirror',
      });
      continue;
    }

    // 2. Never overwrite: if a canonical row already exists, leave it untouched.
    if (await exists(jobId)) {
      report.skipped.push({
        jobId,
        legacyId: legacy.id,
        reason: 'already-backfilled',
        detail: 'Erc8183Job already present for this jobId; never overwritten',
      });
      continue;
    }

    // 3. Read authoritative on-chain state.
    const chainResult = await opts.chainRead(jobId);
    if (chainResult.kind === 'error') {
      report.skipped.push({
        jobId,
        legacyId: legacy.id,
        reason: 'rpc-error',
        detail: chainResult.error,
      });
      continue;
    }
    if (chainResult.kind === 'missing') {
      report.skipped.push({
        jobId,
        legacyId: legacy.id,
        reason: 'missing-on-chain',
        detail: 'no ERC-8183 job at this jobId (getJob reverted / zeroed slot)',
      });
      continue;
    }
    const job = chainResult.job;
    if (job.id !== jobId) {
      report.skipped.push({
        jobId,
        legacyId: legacy.id,
        reason: 'ambiguous',
        detail: `on-chain job id ${job.id} != legacy-encoded jobId ${jobId}`,
      });
      continue;
    }

    // 4. Cross-check legacy DB vs on-chain (hard mismatch gates).
    const mismatches: MismatchItem[] = [];
    if (legacy.description && legacy.description.trim() !== job.description.trim()) {
      mismatches.push({
        jobId,
        legacyId: legacy.id,
        field: 'description',
        legacyValue: legacy.description,
        chainValue: job.description,
      });
    }
    if (legacy.agentId && normalizeAddr(legacy.agentId) !== normalizeAddr(job.provider)) {
      mismatches.push({
        jobId,
        legacyId: legacy.id,
        field: 'provider',
        legacyValue: legacy.agentId,
        chainValue: job.provider,
      });
    }
    if (mismatches.length > 0) {
      report.mismatch.push(...mismatches);
      report.skipped.push({
        jobId,
        legacyId: legacy.id,
        reason: 'mismatch',
        detail: mismatches.map((m) => `${m.field}: legacy[${m.legacyValue}] vs chain[${m.chainValue}]`).join('; '),
      });
      continue;
    }

    // 5. Assemble the canonical row — only when every required field is proven.
    const built = buildCreatePayload(legacy, job);
    if (!built.ok) {
      report.skipped.push({
        jobId,
        legacyId: legacy.id,
        reason: 'ambiguous',
        detail: built.reason,
      });
      continue;
    }

    // 6. Persist (unless dry-run). Mark as created FIRST so in-run duplicates
    //    are treated as already-backfilled and never double-written.
    createdThisRun.add(jobId.toString());
    if (opts.persist && !opts.dryRun) {
      try {
        await opts.persist(built.payload);
      } catch (e: any) {
        if ((e as any)?.code === 'P2002') {
          // Unique violation — a concurrent writer created it. Skip, never
          // overwrite, and retract our in-run claim so we don't report it.
          createdThisRun.delete(jobId.toString());
          report.skipped.push({
            jobId,
            legacyId: legacy.id,
            reason: 'already-backfilled',
            detail: 'concurrent create detected (unique jobId already exists)',
          });
          continue;
        }
        throw e;
      }
    }
    report.backfilled.push({
      jobId,
      legacyId: legacy.id,
      wouldBackfill: opts.dryRun,
      ...(opts.dryRun ? { payload: built.payload } : {}),
    });
  }

  // Duplicate proof: at most one backfill record per jobId.
  const backfilledIds = new Set(report.backfilled.map((b) => b.jobId.toString()));
  report.noDuplicate = backfilledIds.size === report.backfilled.length;
  return report;
}
// ── human-readable report (no I/O) ──────────────────────────────────────────
export function formatReport(report: BackfillReport, dryRun: boolean): string {
  const mode = dryRun ? 'DRY-RUN (no rows created)' : 'APPLIED';
  const lines: string[] = [];
  lines.push(`=== ERC-8183 pre-Track-3 backfill report [${mode}] ===`);
  lines.push(`Processed ${report.discovered} legacy Direct-Hire candidate(s)`);
  lines.push(`  backfilled:   ${report.backfilled.length}`);
  lines.push(`  skipped:      ${report.skipped.length}`);
  lines.push(`  mismatched:   ${report.mismatch.length}`);
  lines.push(`  no-duplicate: ${report.noDuplicate}`);
  for (const b of report.backfilled) {
    lines.push(
      `  [backfilled] jobId=${b.jobId} legacy=${b.legacyId} status=${b.payload?.status ?? ''} ` +
        `client=${b.payload?.clientSCA ?? ''} provider=${b.payload?.providerSCA ?? ''}`
    );
  }
  for (const s of report.skipped) {
    lines.push(`  [skipped:${s.reason}] jobId=${s.jobId ?? '-'} legacy=${s.legacyId ?? '-'} — ${s.detail}`);
  }
  for (const m of report.mismatch) {
    lines.push(`  [mismatch:${m.field}] jobId=${m.jobId} legacy=${m.legacyId}`);
    lines.push(`      legacy: ${m.legacyValue}`);
    lines.push(`      chain:  ${m.chainValue}`);
  }
  return lines.join('\n');
}