// src/lib/payments/platformFee.ts
//
// Platform-fee exactly-once (production hardening).
//
// INVARIANT: one successful PaymentLog produces AT MOST ONE Circle
// platform-fee transfer — across duplicate API requests, concurrent
// requests, and process crashes/retries.
//
// Why a DB constraint alone is insufficient: @@unique([paymentLogId]) makes
// the ROW single, but two requests can both read "no row", both call Circle,
// and only then race on the insert — two external transfers, one surviving
// row. The external money movement itself must be protected, so this module
// uses claim-before-transfer:
//
//   1. CLAIM: create the PlatformFee row as PENDING (unique on paymentLogId)
//      BEFORE any Circle call. Concurrent duplicates race on the unique
//      constraint — losers re-read the winner and never transfer.
//   2. ANCHOR: persist circleTxId IMMEDIATELY after creation, BEFORE polling
//      for finality. A crash after this point is recoverable: the next
//      attempt finds the id and resumes polling instead of creating again.
//   3. IDEMPOTENCY KEY: every creation attempt for one payment reuses the
//      same stable key (`platform-fee:<paymentLogId>`), so a Circle endpoint
//      that honors it dedupes server-side too.
//   4. TERMINAL STATES decide retry safety: Circle FAILED -> the transfer will
//      never land, the id is discarded, retry may create fresh (same key).
//      Anything else (timeout/unreachable) -> finality UNKNOWN, the id stays
//      tracked, the next attempt resumes it; a second transfer is never made
//      while an id is tracked.
//
// RESIDUAL MICRO-WINDOW (documented, same class as trackedTransfer.ts): the
// back-to-back awaits between createCircleTransfer returning and the
// circleTxId-persist write. A crash exactly inside that window leaves a live
// Circle transfer with no tracked id; Circle's ARC endpoint rejects client
// idempotency keys, so no client dedupe can close it. The window holds no
// other work, and a PENDING-without-id claim younger than STALE_MS fails
// closed (treated as a live flight — never a blind second transfer) until
// the grace expires.
//
// FEE FAILURE NEVER SETTLES BACKWARDS: this module only ever touches
// PlatformFee rows. It never updates PaymentLog, so a fee operational failure
// cannot roll back (or falsely report failure of) a payment that already
// settled SUCCESS.

import { prisma } from '@/src/lib/prisma';
import { claimTxSlot } from '@/src/lib/swap/service';
import { createCircleTransfer, awaitCircleTx } from '@/src/lib/circle/transfers';

export const FEE_STALE_MS = 5 * 60 * 1000;

export function feeIdempotencyKey(paymentLogId: string): string {
  return `platform-fee:${paymentLogId}`;
}

export interface FeeRow {
  id: string;
  paymentLogId: string;
  merchantId: string;
  amountCharged: number;
  amountReceived: number | null;
  status: string;
  txHash: string | null;
  deferredReason: string | null;
  circleTxId: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

/** Caller-computed preconditions (balances, wallet type, config). */
export type FeeDecision =
  | {
      kind: 'collect';
      walletId: string;
      walletAddress: string;
      destinationAddress: string;
      amountStr: string;
      tokenAddress: string;
      decimals: number;
    }
  | { kind: 'defer'; reason: string };

export interface FeeStore {
  findByPayment(paymentLogId: string): Promise<FeeRow | null>;
  /** Must throw { code: 'P2002' } when a row for the payment already exists. */
  createPending(data: {
    paymentLogId: string;
    merchantId: string;
    amountCharged: number;
    idempotencyKey: string;
  }): Promise<FeeRow>;
  createDeferred(data: {
    paymentLogId: string;
    merchantId: string;
    amountCharged: number;
    deferredReason: string;
  }): Promise<FeeRow>;
  setCircleTxId(id: string, circleTxId: string): Promise<void>;
  markSuccess(id: string, data: { txHash: string; amountReceived: number }): Promise<FeeRow>;
  /** Terminal failure: clears any tracked id (it will never land). */
  markFailedTerminal(id: string, reason: string): Promise<void>;
  /** Unknown finality: keeps the tracked id for resume. */
  markUnknown(id: string): Promise<void>;
  /**
   * Run fn with a claim-scoped store. The Prisma implementation opens a
   * transaction, takes the advisory lock for this payment, and hands fn a
   * transaction-bound store — so lock + find + create are one atomic unit.
   * Fakes may hand back themselves (uniqueness + P2002 catch stay atomic).
   */
  serialize<T>(paymentLogId: string, fn: (scoped: FeeStore) => Promise<T>): Promise<T>;
}

export interface FeeTransferPorts {
  createTransfer(p: {
    walletId: string;
    walletAddress: string;
    destinationAddress: string;
    amount: string;
    tokenAddress: string;
    decimals: number;
    idempotencyKey: string;
  }): Promise<{ circleTxId: string }>;
  pollTransfer(circleTxId: string): Promise<string>;
  measureReceived?: () => Promise<number | null>;
}

export type FeeOutcome =
  | { action: 'collected'; row: FeeRow }
  | { action: 'resumed'; row: FeeRow }
  | { action: 'skipped'; reason: string; row?: FeeRow | null }
  | { action: 'deferred'; row: FeeRow }
  | { action: 'failed'; reason: string; row: FeeRow };

function isConflict(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'P2002';
}

/**
 * Transient pooled-DB transaction errors (P2028/P2034): the transaction never
 * started, no state changed, the fee attempt is safely retryable. Surfaced so
 * callers can distinguish "retry" from "failed".
 */
export function isFeeTransientError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'P2028' || code === 'P2034';
}

/** Terminal Circle failure: the tracked transfer will never land. */
export function isTerminalCircleError(e: unknown): boolean {
  const msg = String((e as Error | null)?.message ?? e ?? '');
  return /Circle tx failed|Both native and fallback initialization failed/i.test(msg);
}

export async function settlePlatformFeeOnce(args: {
  store: FeeStore;
  ports: FeeTransferPorts;
  paymentLogId: string;
  merchantId: string;
  amountCharged: number;
  decision: FeeDecision;
  now?: () => number;
  staleMs?: number;
}): Promise<FeeOutcome> {
  const { store, ports, paymentLogId, merchantId, amountCharged, decision } = args;
  const now = args.now ?? Date.now;
  const staleMs = args.staleMs ?? FEE_STALE_MS;
  const key = feeIdempotencyKey(paymentLogId);

  // ── 1. Existing lifecycle row? Follow the state machine, never transfer blind.
  let row = await store.findByPayment(paymentLogId);
  if (row) {
    if (row.status === 'SUCCESS') return { action: 'skipped', reason: 'already-collected', row };
    if (row.status === 'DEFERRED') return { action: 'skipped', reason: 'already-deferred', row };
    if (row.status === 'PENDING' && row.circleTxId) {
      return resumePoll(store, ports, row, undefined, true);
    }
    if (row.status === 'PENDING' && !row.circleTxId) {
      const ageMs = now() - new Date(row.createdAt).getTime();
      if (ageMs < staleMs) {
        return { action: 'skipped', reason: 'in-progress', row };
      }
      // Stale without a tracked id: the owner crashed before creation (the
      // only state from which takeover is safe). Fall through and create
      // exactly one transfer under the same idempotency key.
      return createAndTrack(store, ports, row, decision, key, amountCharged);
    }
    if (row.status === 'FAILED' && !row.circleTxId) {
      // Terminal/never-created failure only (FAILED is written solely when no
      // live transfer can exist). Retry under the same key.
      return createAndTrack(store, ports, row, decision, key, amountCharged);
    }
    // FAILED *with* a tracked id, SETTLEMENT_ERROR, or anything unexpected:
    // finality unknown — resume the tracked transfer, never create.
    if (row.circleTxId) {
      return resumePoll(store, ports, row, undefined, true);
    }
    return { action: 'skipped', reason: `unexpected-fee-state:${row.status}`, row };
  }

  // ── 2. Claim the fee lifecycle (concurrent duplicates race here).
  // Lock + recheck + create run inside the store's serialized scope, and the
  // UNIQUE constraint on paymentLogId is the atomic backstop: losers re-read
  // the winner and never reach the transfer.
  const claimed = await store.serialize(paymentLogId, async (scoped) => {
    const recheck = await scoped.findByPayment(paymentLogId);
    if (recheck) return { row: recheck, createdHere: false as const };
    try {
      if (decision.kind === 'defer') {
        const created = await scoped.createDeferred({
          paymentLogId,
          merchantId,
          amountCharged,
          deferredReason: decision.reason,
        });
        return { row: created, createdHere: false as const, deferred: true as const };
      }
      const created = await scoped.createPending({
        paymentLogId,
        merchantId,
        amountCharged,
        idempotencyKey: key,
      });
      return { row: created, createdHere: true as const };
    } catch (e) {
      if (!isConflict(e)) throw e;
      const winner = await scoped.findByPayment(paymentLogId);
      if (!winner) throw e;
      return { row: winner, createdHere: false as const };
    }
  });

  if ('deferred' in claimed && claimed.deferred) {
    return { action: 'deferred', row: claimed.row };
  }
  if (!claimed.createdHere) {
    // Lost the race (or a row appeared between step 1 and the claim):
    // re-run the state machine on the winner — never transfer.
    return settlePlatformFeeOnce({ ...args, decision });
  }
  if (decision.kind === 'defer') {
    // Decision flipped mid-claim (should not happen — defer creates above);
    // fail closed without transferring.
    return { action: 'skipped', reason: 'decision-changed', row: claimed.row };
  }
  return createAndTrack(store, ports, claimed.row, decision, key, amountCharged);
}

async function createAndTrack(
  store: FeeStore,
  ports: FeeTransferPorts,
  row: FeeRow,
  decision: FeeDecision,
  key: string,
  amountCharged: number
): Promise<FeeOutcome> {
  if (decision.kind === 'defer') {
    return { action: 'skipped', reason: 'already-claimed-pending', row };
  }
  let circleTxId: string;
  try {
    ({ circleTxId } = await ports.createTransfer({
      walletId: decision.walletId,
      walletAddress: decision.walletAddress,
      destinationAddress: decision.destinationAddress,
      amount: decision.amountStr,
      tokenAddress: decision.tokenAddress,
      decimals: decision.decimals,
      idempotencyKey: key,
    }));
  } catch (e: any) {
    // Creation failed: no transfer exists (or it terminally failed) — mark
    // FAILED without an id so a later retry may attempt once more.
    await store.markFailedTerminal(row.id, String(e?.message ?? e).slice(0, 500));
    const failed = (await store.findByPayment(row.paymentLogId)) ?? row;
    return { action: 'failed', reason: String(e?.message ?? e).slice(0, 200), row: failed };
  }

  // Crash anchor: persist the id BEFORE polling — back-to-back awaits, no
  // other work between creation and this write.
  await store.setCircleTxId(row.id, circleTxId);
  return resumePoll(store, ports, { ...row, circleTxId }, amountCharged, false);
}

async function resumePoll(
  store: FeeStore,
  ports: FeeTransferPorts,
  row: FeeRow,
  amountChargedFallback?: number,
  resumed = false
): Promise<FeeOutcome> {
  const circleTxId = row.circleTxId!;
  try {
    const arcTxHash = await ports.pollTransfer(circleTxId);
    let amountReceived: number | null = null;
    try {
      amountReceived = (await ports.measureReceived?.()) ?? null;
    } catch {
      amountReceived = null;
    }
    const done = await store.markSuccess(row.id, {
      txHash: arcTxHash,
      amountReceived: amountReceived ?? row.amountCharged ?? amountChargedFallback ?? 0,
    });
    return { action: resumed ? 'resumed' : 'collected', row: done };
  } catch (e: any) {
    if (isTerminalCircleError(e)) {
      await store.markFailedTerminal(row.id, String(e?.message ?? e).slice(0, 500));
      const failed = (await store.findByPayment(row.paymentLogId)) ?? row;
      return { action: 'failed', reason: String(e?.message ?? e).slice(0, 200), row: failed };
    }
    // Timeout / unreachable: finality UNKNOWN — keep the tracked id so the
    // next attempt resumes polling instead of creating a second transfer.
    await store.markUnknown(row.id).catch(() => null);
    const kept = (await store.findByPayment(row.paymentLogId)) ?? row;
    return { action: 'failed', reason: `unknown-finality:${String(e?.message ?? e).slice(0, 120)}`, row: kept };
  }
}

/** Prisma-backed store (routes use this). */
export function prismaPlatformFeeStore(db: any = prisma): FeeStore {
  const toRow = (r: any): FeeRow => ({
    id: r.id,
    paymentLogId: r.paymentLogId,
    merchantId: r.merchantId,
    amountCharged: r.amountCharged,
    amountReceived: r.amountReceived ?? null,
    status: r.status,
    txHash: r.txHash ?? null,
    deferredReason: r.deferredReason ?? null,
    circleTxId: r.circleTxId ?? null,
    idempotencyKey: r.idempotencyKey ?? null,
    createdAt: new Date(r.createdAt),
  });
  function bind(delegate: any, tx: any | null): FeeStore {
    const store: FeeStore = {
      findByPayment: async (paymentLogId) => {
        const r = await delegate.findUnique({ where: { paymentLogId } }).catch(() => null);
        return r ? toRow(r) : null;
      },
      createPending: async (data) =>
        toRow(await delegate.create({ data: { ...data, status: 'PENDING' } })),
      createDeferred: async (data) =>
        toRow(await delegate.create({ data: { ...data, status: 'DEFERRED' } })),
      setCircleTxId: async (id, circleTxId) => {
        await delegate.update({ where: { id }, data: { circleTxId } });
      },
      markSuccess: async (id, data) =>
        toRow(await delegate.update({ where: { id }, data: { status: 'SUCCESS', ...data } })),
      markFailedTerminal: async (id, reason) => {
        await delegate.update({
          where: { id },
          data: { status: 'FAILED', circleTxId: null, deferredReason: reason },
        });
      },
      markUnknown: async (id) => {
        await delegate.update({ where: { id }, data: { status: 'PENDING' } }).catch(() => null);
      },
      serialize: async <T>(paymentLogId: string, fn: (scoped: FeeStore) => Promise<T>) => {
        // Serialize claimants for one payment inside a transaction using the
        // project's established advisory-lock pattern, so concurrent API
        // requests line up on the claim instead of racing past it. The
        // UNIQUE constraint remains the atomic backstop (P2002 -> replay).
        if (tx && typeof tx.$transaction === 'function') {
          return fn(store);
        }
        if (typeof db.$transaction === 'function') {
          return db.$transaction(async (inner: any) => {
            await claimTxSlot(inner, `platform-fee:${paymentLogId}`);
            return fn(bind(inner.platformFee, inner));
          });
        }
        return fn(store);
      },
    };
    return store;
  }
  return bind(db.platformFee ?? db, null);
}

/** Real Circle ports (routes use these). */
export function circleFeePorts(measureReceived?: () => Promise<number | null>): FeeTransferPorts {
  return {
    createTransfer: async (p) => createCircleTransfer(p),
    pollTransfer: async (circleTxId) => awaitCircleTx(circleTxId),
    ...(measureReceived ? { measureReceived } : {}),
  };
}
