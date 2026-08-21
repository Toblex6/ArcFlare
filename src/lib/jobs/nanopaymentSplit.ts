/**
 * nanopaymentSplit.ts
 *
 * Nanopayments for jobs: instead of one lump-sum release at the end, pay
 * the worker per completed criterion as the reviewer confirms each one.
 *
 * ON-CHAIN STATUS — LIVE (2026-08-20):
 * ArcFlareStream.sol is implemented and deployed on Arc Testnet
 * (0xd8ca3Bbc212F36666145fAa487D45742eA04A52B, bytecode verified). This
 * module uses the REAL ABI from src/lib/contracts/streamContract.ts and the
 * shared receipt parser (src/lib/contracts/receiptParser.ts) for the real
 * StreamOpened event. It owns the deterministic tranche math (bigint only,
 * remainder in the last tranche), the DB state machine over the existing
 * JobNanopaymentStream / JobNanopaymentTranche models, and the crash-
 * recovery path for "tx landed, DB write lost". The routes execute the
 * on-chain writes via the poster's Circle SCA (createContractTransaction,
 * same convention as the other jobs routes) and hand the txHash + parsed
 * streamId to this module.
 *
 * Authorization model (enforced in the routes, pinned to the job's own
 * addresses — never from the request body):
 *   - open:   the job's client (poster) — caller must control job.clientSCA
 *   - release: the poster OR the job's evaluator (authorized reviewer) —
 *             but the on-chain signer is ALWAYS the poster's wallet
 *   - close:  same as release
 * The contract itself allows only streams[streamId].poster to release/close,
 * and there is NO refund-to-poster path anywhere.
 */

import { prisma } from "@/lib/prisma";
import { parseEventValue } from "@/lib/contracts/receiptParser";
import {
  ARC_FLARE_STREAM_ABI,
  computeTrancheAmounts,
  findTrancheReleaseTxHash,
  isTrancheReleasedOnChain,
  readStreamOnChain,
  readTrancheAmount,
} from "@/lib/contracts/streamContract";
import { hashCriteria, type AcceptanceCriteria } from "@/lib/jobs/criteriaHash";

export interface OpenNanopaymentInput {
  jobId: string;
  txHash: string;
  streamId: string;
  workerAddress: string;
  token: string;
  totalBudget: string; // smallest token units, exact
  criteria: AcceptanceCriteria;
}

/**
 * Records an opened stream (the on-chain openStream tx has already landed —
 * streamId parsed from the real StreamOpened event). Idempotent: if a row
 * already exists for this job it is returned as-is (re-open replay).
 */
export async function recordNanopaymentStreamOpened(
  input: OpenNanopaymentInput
): Promise<{ id: string; streamId: string; replayed: boolean }> {
  const existing = await prisma.jobNanopaymentStream.findUnique({
    where: { jobId: input.jobId },
  });
  if (existing) {
    return { id: existing.id, streamId: existing.streamId, replayed: true };
  }

  const trancheCount = input.criteria.requirements.length;
  const row = await prisma.jobNanopaymentStream.create({
    data: {
      jobId: input.jobId,
      streamId: input.streamId,
      workerAddress: input.workerAddress,
      totalBudget: input.totalBudget,
      trancheCount,
      tranchesReleased: 0,
      token: input.token,
      criteriaHash: hashCriteria(input.criteria),
    },
  });
  return { id: row.id, streamId: row.streamId, replayed: false };
}

export interface ReleaseNanopaymentInput {
  jobId: string;
  requirementIndex: number;
  txHash: string;
}

/**
 * Records a released tranche. The unique [jobId, requirementIndex]
 * constraint is the idempotency backstop: a concurrent duplicate insert
 * (retried webhook, double HTTP request) hits P2002 and resolves to the
 * winning row instead of double-paying.
 *
 * Recovery: if the caller supplies txHash == null (the on-chain tx reverted
 * with "already released" — meaning a previous release landed but its DB
 * write was lost), this re-reads the on-chain releasedTranches flag and
 * finds the real txHash from TrancheReleased events, then writes the row.
 */
export async function recordNanopaymentTrancheReleased(
  input: ReleaseNanopaymentInput
): Promise<{ txHash: string; replayed: boolean }> {
  const existing = await prisma.jobNanopaymentTranche.findUnique({
    where: { jobId_requirementIndex: { jobId: input.jobId, requirementIndex: input.requirementIndex } },
  });
  if (existing) {
    // Idempotent — calling this twice for the same requirement (e.g. a
    // retried review-approval webhook) must not double-pay.
    return { txHash: existing.txHash, replayed: true };
  }

  const streamRecord = await prisma.jobNanopaymentStream.findUnique({
    where: { jobId: input.jobId },
  });
  if (!streamRecord) {
    throw new Error(`no nanopayment stream found for job ${input.jobId} — was the stream opened?`);
  }

  let txHash = input.txHash;
  if (!txHash) {
    // Recovery path: the release landed on-chain (revert "already released")
    // but this DB row was never written. Recover the real txHash from the
    // TrancheReleased events instead of paying again.
    const onChain = await isTrancheReleasedOnChain(BigInt(streamRecord.streamId), input.requirementIndex);
    if (!onChain) {
      throw new Error(
        `release for requirement ${input.requirementIndex} reverted on-chain and is not marked released — refusing to fabricate a DB row`
      );
    }
    const recovered = await findTrancheReleaseTxHash(
      BigInt(streamRecord.streamId),
      input.requirementIndex
    );
    if (!recovered) {
      throw new Error(
        `release marked on-chain but TrancheReleased event not found for stream ${streamRecord.streamId} index ${input.requirementIndex}`
      );
    }
    txHash = recovered;
  }

  try {
    await prisma.$transaction([
      prisma.jobNanopaymentTranche.create({
        data: {
          jobId: input.jobId,
          requirementIndex: input.requirementIndex,
          txHash,
        },
      }),
      prisma.jobNanopaymentStream.update({
        where: { id: streamRecord.id },
        data: { tranchesReleased: { increment: 1 } },
      }),
    ]);
    return { txHash, replayed: false };
  } catch (e: any) {
    // Concurrent duplicate release: the other request won the unique
    // constraint. Return the winner instead of double-paying.
    if (e?.code === "P2002") {
      const winner = await prisma.jobNanopaymentTranche.findUnique({
        where: { jobId_requirementIndex: { jobId: input.jobId, requirementIndex: input.requirementIndex } },
      });
      if (winner) return { txHash: winner.txHash, replayed: true };
    }
    throw e;
  }
}

export interface CloseNanopaymentInput {
  jobId: string;
  txHash: string;
}

/**
 * Records a finalized stream (closeStream tx has landed on-chain).
 * Idempotent: closing an already-closed stream returns the existing row.
 */
export async function recordNanopaymentStreamClosed(
  input: CloseNanopaymentInput
): Promise<{ closedAt: Date; replayed: boolean }> {
  const streamRecord = await prisma.jobNanopaymentStream.findUnique({
    where: { jobId: input.jobId },
  });
  if (!streamRecord) {
    throw new Error(`no nanopayment stream found for job ${input.jobId}`);
  }
  if (streamRecord.closedAt) {
    return { closedAt: streamRecord.closedAt, replayed: true };
  }

  await prisma.jobNanopaymentStream.update({
    where: { id: streamRecord.id },
    data: {
      tranchesReleased: streamRecord.trancheCount,
      closedAt: new Date(),
    },
  });

  return { closedAt: new Date(), replayed: false };
}

export interface NanopaymentStreamStatus {
  db: {
    streamId: string;
    workerAddress: string;
    totalBudget: string;
    trancheCount: number;
    tranchesReleased: number;
    token: string;
    criteriaHash: string | null;
    closedAt: Date | null;
  } | null;
  onChain: {
    streamId: string;
    poster: string;
    worker: string;
    token: string;
    totalBudget: string;
    trancheCount: string;
    tranchesReleased: string;
    totalReleased: string;
    closed: boolean;
    openedAt: string;
    releasedIndexes: number[];
    trancheAmounts: string[];
  } | null;
}

/**
 * Full nanopayment status for a job: DB mirror + live on-chain state
 * (same-block reads against the stream contract). `releasedIndexes` and
 * `trancheAmounts` are derived from the contract's own views, so the
 * status route never trusts the DB mirror alone.
 */
export async function getNanopaymentStreamStatus(jobId: string): Promise<NanopaymentStreamStatus> {
  const dbRow = await prisma.jobNanopaymentStream.findUnique({ where: { jobId } });
  if (!dbRow) {
    return { db: null, onChain: null };
  }

  const streamId = BigInt(dbRow.streamId);
  const onChain = await readStreamOnChain(streamId);

  const trancheCount = Number(onChain.trancheCount);
  const releasedIndexes: number[] = [];
  const trancheAmounts: string[] = [];
  for (let i = 0; i < trancheCount; i++) {
    trancheAmounts.push((await readTrancheAmount(streamId, i)).toString());
    if (await isTrancheReleasedOnChain(streamId, i)) releasedIndexes.push(i);
  }

  return {
    db: {
      streamId: dbRow.streamId,
      workerAddress: dbRow.workerAddress,
      totalBudget: dbRow.totalBudget,
      trancheCount: dbRow.trancheCount,
      tranchesReleased: dbRow.tranchesReleased,
      token: dbRow.token,
      criteriaHash: dbRow.criteriaHash,
      closedAt: dbRow.closedAt,
    },
    onChain: {
      streamId: dbRow.streamId,
      poster: onChain.poster,
      worker: onChain.worker,
      token: onChain.token,
      totalBudget: onChain.totalBudget.toString(),
      trancheCount: onChain.trancheCount.toString(),
      tranchesReleased: onChain.tranchesReleased.toString(),
      totalReleased: onChain.totalReleased.toString(),
      closed: onChain.closed,
      openedAt: onChain.openedAt.toString(),
      releasedIndexes,
      trancheAmounts,
    },
  };
}

/**
 * Shared event-parser wrapper: extracts the on-chain streamId from a
 * receipt using the REAL StreamOpened event ABI.
 */
export function extractStreamIdFromReceipt(receipt: any): bigint {
  return parseEventValue(receipt, ARC_FLARE_STREAM_ABI as unknown as string[], "StreamOpened", "streamId");
}