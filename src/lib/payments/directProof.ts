// src/lib/payments/directProof.ts
//
// H1 — direct-checkout payment-proof single-consumption.
//
// INVARIANT: one direct (non-routed) on-chain Transfer proof settles AT MOST
// ONE invoice, even under concurrency.
//
// Threat: verify-onchain accepts a client-supplied txHash whose receipt holds
// a qualifying Transfer into the merchant wallet. Without consumption, one
// real transfer can mark N invoices SUCCESS (replay across invoices), and two
// concurrent verifications can both settle before either persists.
//
// Enforcement (defense in depth, all server-side):
//   1. The consumed proof is the EXACT log: (chainId, txHash, logIndex) with a
//      DB unique constraint (DirectPaymentProof). Same txHash + different
//      logIndex are distinct proofs; same triple can never settle twice.
//   2. The claim row is created INSIDE the same database transaction that
//      flips the PaymentLog to SUCCESS. Concurrent claimants serialize on a
//      tx-scoped advisory lock (the project's established claimTxSlot
//      pattern) and the loser deterministically gets 409 — no check-then-act.
//   3. Failed verification creates NO row (the claim only runs after every
//      on-chain check passes), so failures can never poison a proof.
//   4. A Transfer whose block timestamp predates the invoice (minus skew
//      grace) cannot settle it — a transfer that happened before the invoice
//      existed is unrelated by construction.
//
// GRIEFING RESIDUAL (documented, not closable for permissionless checkout):
// proof submission is permissionless — anyone may submit anyone's txHash. An
// attacker who pre-creates their own invoice naming the VICTIM merchant as
// recipient (only the consumer-initialize send path allows an arbitrary
// payoutAddress; merchant payment-links are auth-bound) and wins the claim
// race would pin the victim's proof to the attacker's invoice. The victim's
// funds still reached the real merchant wallet, and the victim invoice stays
// PENDING (never falsely SUCCESS), but that transfer can never settle the
// victim invoice afterwards. Mitigations in place: timestamp rule (attacker
// invoices created after the transfer are rejected), same-merchant +
// sufficient-amount binding, 409 on consumed proofs. Closing this fully
// would require payer-signature proof-of-ownership (the buyer signing the
// reference), which the non-custodial model deliberately does not collect.

import { decodeEventLog } from 'viem';
import { erc20TransferAbi } from '@/src/lib/wallet/erc20';
import { getNetworkConfig } from '@/lib/config/network';
import { claimTxSlot } from '@/src/lib/swap/service';

/** Typed 409 raised when a proof is already consumed (carries HTTP status). */
export function directProofConflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

/**
 * Transient pooled-DB transaction errors (Neon/PgBouncer: "Unable to start a
 * transaction in the given time" under burst concurrency). The transaction
 * NEVER STARTED, so no state changed and the request is safely retryable —
 * surface as 503, never 500, so callers retry instead of treating the
 * payment as failed.
 */
export function isTransientTxError(e: any): boolean {
  return e?.code === 'P2028' || e?.code === 'P2034';
}

export function transientTxRetryable(message = 'Database is busy — retry shortly.'): Error & {
  status: number;
} {
  return Object.assign(new Error(message), { status: 503 });
}

/** Map a lost uniqueness race at commit time to a deterministic 409. */
export function directProofCommitConflict(e: any): Error & { status: number } {
  if (isTransientTxError(e)) {
    return transientTxRetryable();
  }
  if (e?.code === 'P2002') {
    return directProofConflict(
      'This transaction was already consumed by another payment.'
    );
  }
  throw e;
}

export function normalizeTxHash(txHash: string): string {
  return txHash.trim().toLowerCase();
}

export interface DirectTransferMatch {
  from: string;
  value: bigint;
  logIndex: number;
}

/**
 * Pure receipt-log matcher: the FIRST Transfer log emitted by the resolved
 * settlement-token contract paying the merchant wallet at least the invoice
 * amount. Logs from any other contract are ignored (a USDC log never
 * satisfies an EURC invoice and vice versa). Returns the matched logIndex so
 * the caller can claim exactly that proof — never just the txHash.
 */
export function findDirectTransfer(
  logs: Array<{ address: string; data: string; topics: any; logIndex?: number | null }>,
  expected: { tokenAddress: string; merchantSCA: string; expectedAmount: bigint }
): DirectTransferMatch | null {
  const merchantAddr = expected.merchantSCA.toLowerCase();
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]!;
    if (log.address.toLowerCase() !== expected.tokenAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20TransferAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as any,
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { to, from, value } = decoded.args as unknown as {
        to: string;
        from: string;
        value: bigint;
      };
      if (to.toLowerCase() === merchantAddr && value >= expected.expectedAmount) {
        const logIndex =
          typeof log.logIndex === 'number' && Number.isInteger(log.logIndex) && log.logIndex >= 0
            ? log.logIndex
            : i;
        return { from, value, logIndex };
      }
    } catch {
      continue; // not a Transfer log, skip
    }
  }
  return null;
}

/**
 * A transfer mined BEFORE the invoice existed cannot pay it. Grace covers
 * DB/chain clock skew only (60s) — anything older is unrelated by
 * construction and fails closed.
 */
export function assertTransferNotPredatingInvoice(args: {
  blockTimestampSec: number;
  invoiceCreatedAt: Date;
  skewGraceMs?: number;
}): void {
  const grace = args.skewGraceMs ?? 60_000;
  if (!Number.isInteger(args.blockTimestampSec) || args.blockTimestampSec <= 0) {
    throw directProofConflict('Could not read execution block timestamp — refusing.');
  }
  const blockMs = args.blockTimestampSec * 1000;
  const createdMs = new Date(args.invoiceCreatedAt).getTime();
  if (!Number.isFinite(createdMs)) {
    throw directProofConflict('Invoice creation time is unreadable — refusing.');
  }
  if (blockMs < createdMs - grace) {
    const err = new Error(
      'This transfer predates the invoice — an unrelated earlier payment cannot settle it.'
    ) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}

/**
 * Mainnet merchant-checkout settlement policy: USDC-only. Testnet keeps the
 * intentionally-supported multicurrency behavior; historical EURC rows are
 * never mutated by this gate (it only refuses NEW settlements).
 */
export function assertMainnetSettlementAllowed(
  symbol: string,
  env: Record<string, string | undefined> = process.env
): void {
  if (getNetworkConfig(env).name === 'mainnet' && symbol !== 'USDC') {
    const err = new Error(
      `Merchant checkout on Arc Mainnet settles USDC only — ${symbol} settlement is rejected. ` +
        `Use USDC for this payment.`
    ) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}

export interface DirectSettleInput {
  /** Prisma client (or transaction client) with paymentLog + directPaymentProof delegates. */
  db: any;
  reference: string;
  paymentId: string;
  chainId: number;
  txHash: string;
  logIndex: number;
  successData: Record<string, unknown>;
}

/**
 * Atomically consume one direct proof and settle its invoice. Opens its own
 * transaction: advisory-lock on the proof triple → in-transaction recheck →
 * create claim + SUCCESS update. Same-proof/same-invoice replays resume
 * idempotently; same-proof/different-invoice loses with 409.
 */
export async function settleDirectPaymentAtomic(
  input: DirectSettleInput
): Promise<{ payment: any; resumed: boolean }> {
  const txHash = normalizeTxHash(input.txHash);
  if (!Number.isInteger(input.logIndex) || input.logIndex < 0) {
    throw directProofConflict('Invalid transfer log index — refusing.');
  }
  try {
    return await input.db.$transaction(async (db: any) => {
      await claimTxSlot(db, `direct-proof:${input.chainId}:${txHash}:${input.logIndex}`);
      const existing = await db.directPaymentProof.findUnique({
        where: { chainId_txHash_logIndex: { chainId: input.chainId, txHash, logIndex: input.logIndex } },
      });
      if (existing) {
        if (existing.paymentLogId === input.paymentId) {
          const live = await db.paymentLog.findUnique({ where: { reference: input.reference } });
          return { payment: live, resumed: true };
        }
        throw directProofConflict('This transaction was already consumed by another payment.');
      }
      // Same-invoice concurrency: a sibling request may have settled this
      // invoice with a DIFFERENT proof while we waited on the lock. The
      // invoice is settled — report it instead of double-settling.
      const live = await db.paymentLog.findUnique({ where: { reference: input.reference } });
      if (live?.status === 'SUCCESS') {
        return { payment: live, resumed: true };
      }
      await db.directPaymentProof.create({
        data: { chainId: input.chainId, txHash, logIndex: input.logIndex, paymentLogId: input.paymentId },
      });
      const payment = await db.paymentLog.update({
        where: { reference: input.reference },
        data: input.successData,
      });
      return { payment, resumed: false };
    });
  } catch (e: any) {
    throw directProofCommitConflict(e);
  }
}
