// src/lib/payments/trackedTransfer.ts
//
// Crash-safe Circle transfer executor shared by the scheduled-payment runner
// (P1-2) and the treasury-credit endpoint (P1-3).
//
// INVARIANT: one idempotencyKey produces AT MOST ONE Circle transfer.
//
// Pattern (reuses the proven payments/settle + nano/settle resume shape,
// adapted to the actual Circle API behavior):
//   1. The PaymentLog row keyed by `idempotencyKey` (unique) is the claim.
//      It is created BEFORE any Circle call, so concurrent duplicates race on
//      the unique constraint — the loser replays the winner, never transfers.
//   2. The Circle transaction ID is persisted to that row AS SOON AS the
//      creation call returns it, BEFORE polling for finality. A crash after
//      this point is recoverable: the next attempt finds the ID and resumes
//      polling instead of creating a second transfer.
//   3. Circle terminal states decide retry safety (verified API behavior):
//      - FAILED  -> terminal, the transfer will never land. The ID is
//        discarded and a fresh transfer may be created (same as settle).
//      - anything else (PENDING/CONFIRMED/timeout/unreachable) -> finality is
//        UNKNOWN. The ID is kept and the next attempt resumes polling it.
//        A second transfer is never created while an ID is tracked.
//   4. `onConfirmed` (ledger writes, schedule advancement) runs AFTER finality
//      and BEFORE the SUCCESS mark, and MUST be idempotent: if the process
//      crashes between `onConfirmed` and the SUCCESS mark, the next attempt
//      resumes polling (fast COMPLETE) and runs `onConfirmed` again.
//
// RESIDUAL MICRO-WINDOW (documented, not closable from our side): the single
// await between `createTransaction` returning and the ID-persist write. A
// crash exactly inside that await leaves a live Circle transfer with no
// tracked ID. Circle's ARC endpoint rejects client idempotency keys
// (verified 2026-08-19, see transfers.ts), so no client-side dedupe can close
// it — the window is one back-to-back await pair with no other work between
// them, and the PROCESSING-without-ID state fails closed (TransferInProgress,
// never a blind second transfer) until the stale-claim grace expires.

/** Terminal Circle failure: the tracked transfer will never land. */
export class CircleTxFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircleTxFailedError';
  }
}

/**
 * Another flight owns this idempotencyKey right now (fresh PROCESSING claim
 * with no tracked transfer yet). The caller must NOT create a transfer —
 * return 409/retry-later and let the owner finish.
 */
export class TransferInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferInProgressError';
  }
}

/** Minimal Circle surface (real SDK client satisfies this; tests inject fakes). */
export interface CircleLike {
  createTransaction(args: unknown): Promise<unknown>;
  createContractExecutionTransaction(args: unknown): Promise<unknown>;
  getTransaction(args: { id: string }): Promise<unknown>;
}

/** Minimal PaymentLog surface (real Prisma delegate satisfies this). */
export interface TrackedTransferLog {
  status: string;
  circleTxId: string | null;
  arcTxHash: string | null;
  timestamp: Date;
  metadata?: unknown;
}

export interface TrackedTransferStore {
  findByIdempotencyKey(key: string): Promise<TrackedTransferLog | null>;
  /** Atomic create-or-throw; must throw { code: 'P2002' } on key conflict. */
  createClaim(data: Record<string, unknown>): Promise<TrackedTransferLog>;
  setCircleTxId(key: string, circleTxId: string): Promise<void>;
  mark(
    key: string,
    data: { status: string; arcTxHash?: string | null; circleTxId?: string | null }
  ): Promise<void>;
}

export interface TrackedTransferArgs {
  store: TrackedTransferStore;
  circle: CircleLike;
  /** Stable per-economic-event key (one scheduled period, one credit request). */
  idempotencyKey: string;
  /** Full PaymentLog.create data (reference, amount, currency, ...). */
  claimData: Record<string, unknown>;
  /** Native transfer creation (must resolve to the raw SDK response). */
  createNative: () => Promise<unknown>;
  /** ERC-20 transfer(address,uint256) fallback creation. */
  createFallback: () => Promise<unknown>;
  /**
   * Runs EXACTLY when a fresh Circle creation is about to happen (never on
   * resume/replay). Spend-limit gates and other state-changing preflights
   * belong here: resume skips them (the spend was recorded when the tracked
   * transfer was created), while FAILED-retry and stale-takeover re-run them
   * (fail-closed: a creation without a gate must be impossible).
   */
  beforeCreate?: () => Promise<void>;
  extractId?: (res: unknown) => string | undefined;
  /**
   * Idempotent completion (ledger writes, schedule advancement). Runs after
   * finality, before the SUCCESS mark; may run twice across crash-recovery.
   */
  onConfirmed?: (txHash: string, info: { resumed: boolean }) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Fresh PROCESSING-without-ID claims younger than this belong to a live flight. */
  staleClaimMs?: number;
  now?: () => number;
}

export interface TrackedTransferResult {
  txHash: string;
  circleTxId: string;
  /** True when an existing tracked transfer was resumed, not newly created. */
  resumed: boolean;
  /** True when a prior SUCCESS row was replayed (no Circle call at all). */
  replayed: boolean;
}

const DEFAULT_POLL_ATTEMPTS = 40;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultExtractId = (res: unknown): string | undefined =>
  (res as { data?: { id?: string } } | null | undefined)?.data?.id ?? undefined;

function txState(res: unknown): { state?: string; txHash?: string; errorReason?: string } {
  return (
    ((res as { data?: { transaction?: { state?: string; txHash?: string; errorReason?: string } } })
      ?.data?.transaction as { state?: string; txHash?: string; errorReason?: string }) ?? {}
  );
}

/** Poll a tracked Circle transfer to finality (same semantics as settle/nano). */
export async function pollCircleTx(
  circle: CircleLike,
  circleTxId: string,
  opts?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<string> {
  const attempts = opts?.attempts ?? DEFAULT_POLL_ATTEMPTS;
  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = opts?.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const res = await circle.getTransaction({ id: circleTxId });
    const tx = txState(res);
    if (tx.state === 'COMPLETE' && tx.txHash) return tx.txHash;
    if (tx.state === 'FAILED') {
      throw new CircleTxFailedError(`Circle tx failed: ${tx.errorReason ?? 'unknown'}`);
    }
  }
  throw new Error('Circle transaction timed out.');
}

function isFailedError(e: unknown): boolean {
  return e instanceof CircleTxFailedError || (e as { name?: string } | null)?.name === 'CircleTxFailedError';
}

function isConflictError(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'P2002';
}

async function confirmAndMark(
  args: TrackedTransferArgs,
  circleTxId: string,
  txHash: string,
  resumed: boolean
): Promise<TrackedTransferResult> {
  // Idempotent completion first; if it throws, SUCCESS is NOT marked, so the
  // next attempt resumes polling and runs it again (never a second transfer).
  await args.onConfirmed?.(txHash, { resumed });
  await args.store.mark(args.idempotencyKey, { status: 'SUCCESS', arcTxHash: txHash });
  return { txHash, circleTxId, resumed, replayed: false };
}

export async function executeTrackedTransfer(args: TrackedTransferArgs): Promise<TrackedTransferResult> {
  const { store, circle, idempotencyKey } = args;
  const extractId = args.extractId ?? defaultExtractId;
  const staleMs = args.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const now = args.now ?? Date.now;
  const pollOpts = { attempts: args.pollAttempts, intervalMs: args.pollIntervalMs, sleep: args.sleep };

  // ── 1. Existing claim? ──────────────────────────────────────────────────
  let log = await store.findByIdempotencyKey(idempotencyKey);

  if (log && (log.status === 'SUCCESS' || log.status === 'SETTLED') && log.arcTxHash) {
    return {
      txHash: log.arcTxHash,
      circleTxId: log.circleTxId ?? '',
      resumed: false,
      replayed: true,
    };
  }

  // ── 2. Tracked transfer exists -> resume polling, never create ──────────
  if (log?.circleTxId) {
    const trackedId = log.circleTxId;
    try {
      const txHash = await pollCircleTx(circle, trackedId, pollOpts);
      return await confirmAndMark(args, trackedId, txHash, true);
    } catch (e) {
      if (isFailedError(e)) {
        // Terminal: discard (settle parity) so a fresh transfer may be made.
        await store.mark(idempotencyKey, { status: 'FAILED', circleTxId: null });
        log = await store.findByIdempotencyKey(idempotencyKey);
      } else {
        // Timeout/unknown finality: the ID stays tracked; the next attempt
        // resumes it. Releasing the outer claim is the caller's job.
        throw e;
      }
    }
  }

  // ── 3. Claim the key (concurrent duplicates race here) ──────────────────
  // claimedHere distinguishes OUR fresh claim (proceed to creation) from a
  // PRE-EXISTING row (another flight's — evaluated in step 4).
  let claimedHere = false;
  if (!log) {
    try {
      log = await store.createClaim({ ...args.claimData, idempotencyKey, status: 'PROCESSING' });
      claimedHere = true;
    } catch (e) {
      if (!isConflictError(e)) throw e;
      // Lost the race: re-read the winner and replay/resume it.
      return await executeTrackedTransfer(args);
    }
  }

  // ── 4. Pre-existing PROCESSING claim with no transfer yet ─────────────────
  // Belongs to a live flight unless it is stale (crashed before creation) or
  // a terminal failure awaiting retry. Never blindly double-create.
  if (!claimedHere && !log.circleTxId && log.status !== 'FAILED' && log.status !== 'SETTLEMENT_ERROR') {
    const ageMs = now() - new Date(log.timestamp).getTime();
    if (ageMs < staleMs) {
      throw new TransferInProgressError(
        `Idempotency key ${idempotencyKey} is already being processed by another request — refusing to create a second transfer. Retry shortly.`
      );
    }
    // Stale without a tracked ID: the owner crashed before creation (the only
    // state from which takeover is safe — a created transfer always persists
    // its ID first). Fall through and create exactly one transfer.
  }

  // ── 5. Create exactly one Circle transfer ───────────────────────────────
  // State-changing preflights (spend gates) run here — exactly on the paths
  // that create, never on resume. A rejected preflight marks the claim FAILED
  // (no transfer exists) so the next attempt retries cleanly instead of
  // wedging behind the in-progress grace period.
  try {
    await args.beforeCreate?.();
  } catch (e) {
    await store.mark(idempotencyKey, { status: 'FAILED' });
    throw e;
  }

  let circleTxId: string | undefined;
  try {
    circleTxId = extractId(await args.createNative());
  } catch {
    circleTxId = undefined;
  }
  if (!circleTxId) {
    try {
      circleTxId = extractId(await args.createFallback());
    } catch {
      circleTxId = undefined;
    }
  }
  if (!circleTxId) {
    await store.mark(idempotencyKey, { status: 'FAILED' });
    throw new Error('Circle transfer failed to initiate on both native and ERC20 routes.');
  }

  // Persist the ID BEFORE polling — this write is the crash-recovery anchor.
  await store.setCircleTxId(idempotencyKey, circleTxId);

  // ── 6. Poll; timeout keeps the ID tracked for resume ────────────────────
  try {
    const txHash = await pollCircleTx(circle, circleTxId, pollOpts);
    return await confirmAndMark(args, circleTxId, txHash, false);
  } catch (e) {
    if (isFailedError(e)) {
      await store.mark(idempotencyKey, { status: 'FAILED', circleTxId: null });
      throw e;
    }
    await store.mark(idempotencyKey, { status: 'SETTLEMENT_ERROR' });
    throw e;
  }
}

/** Prisma-backed store for a PaymentLog claim row (routes use this). */
export function prismaTrackedTransferStore(paymentLog: {
  findUnique(a: unknown): Promise<TrackedTransferLog | null>;
  create(a: unknown): Promise<TrackedTransferLog>;
  update(a: unknown): Promise<unknown>;
}): TrackedTransferStore {
  return {
    findByIdempotencyKey: (key) =>
      paymentLog.findUnique({ where: { idempotencyKey: key } }).catch(() => null),
    createClaim: (data) => paymentLog.create({ data }),
    setCircleTxId: (key, circleTxId) =>
      paymentLog
        .update({ where: { idempotencyKey: key }, data: { circleTxId } })
        .then(() => undefined),
    mark: (key, data) =>
      paymentLog.update({ where: { idempotencyKey: key }, data }).then(() => undefined),
  };
}
