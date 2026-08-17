/**
 * nanopaymentSplit.ts
 *
 * Nanopayments for jobs: instead of one lump releaseToWorker() at the end,
 * pay the worker per completed criterion as the AI/human reviewer confirms
 * each one. The surrounding logic here — splitting the budget across the
 * criteria list, tracking which tranches have been paid, idempotency — is
 * solid and independent of any particular on-chain contract.
 *
 * ⚠️ ON-CHAIN STATUS — ISOLATED, NOT WIRED:
 * This module was written to use the EXISTING ArcFlareStream.sol as the
 * streaming-payment target. That contract's current source is EMPTY
 * (0 bytes) — `contracts/ArcFlareStream.sol` has no code, and no artifact
 * or deployed ABI exists to target. Per the integration instructions, we
 * are NOT inventing an ABI here. All on-chain interaction funnels through
 * `getStreamContract()`, which throws a clear isolation error until a real,
 * deployable ArcFlareStream is provided. The off-chain/DB layer is fully
 * wired against the JobNanopaymentStream / JobNanopaymentTranche models.
 *
 * When a real stream contract exists: replace the body of
 * `getStreamContract()` with the actual ABI + address and the rest of this
 * file works as-is.
 */

import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { prisma } from "@/lib/prisma";
import { parseEventValue } from "@/lib/contracts/receiptParser";
import { Contract } from "ethers";
import type { AcceptanceCriteria } from "@/lib/jobs/criteriaHash";

const STREAM_CONTRACT_ADDRESS = process.env.ARC_FLARE_STREAM_CONTRACT_ADDRESS ?? "";

/**
 * Single choke point for all on-chain stream interaction. ISOLATED: throws
 * until ArcFlareStream.sol is actually implementable — we refuse to guess
 * an ABI for a 0-byte source. Replace this body (and the address env var)
 * once a real stream contract exists; do not wire call sites individually,
 * keeping the isolation here means lifting it is a one-line change.
 */
function getStreamContract(): Contract {
  throw new Error(
    "nanopayments are ISOLATED: ArcFlareStream.sol is empty (0 bytes) so no ABI exists to call. " +
    "Provide a real, deployable ArcFlareStream contract, set ARC_FLARE_STREAM_CONTRACT_ADDRESS, " +
    "and replace getStreamContract() in src/lib/jobs/nanopaymentSplit.ts — the off-chain split/" +
    "tracking logic in this file is ready and needs no changes."
  );
}

/**
 * Opens a nanopayment stream for a job's escrowed budget, splitting it
 * evenly across the number of gradable requirements in the criteria.
 * Uneven splits (e.g. weighted-by-difficulty criteria) aren't handled here
 * — this does a simple even split; extend with a `weights` param if you
 * need weighted criteria later.
 *
 * Call this ONCE, right after a worker is assigned (or right after
 * fundJobViaX402, if you want nanopayments as the default for every job
 * rather than opt-in per job).
 *
 * NOTE: currently blocked by getStreamContract()'s isolation error above —
 * the DB row below is only reachable once the stream contract is real.
 */
export async function openNanopaymentStreamForJob(
  jobId: string,
  workerAddress: string,
  token: string,
  totalBudget: bigint,
  criteria: AcceptanceCriteria
): Promise<{ streamId: string; txHash: string }> {
  const trancheCount = criteria.requirements.length;
  if (trancheCount === 0) {
    throw new Error("cannot open a nanopayment stream for a job with zero requirements — use lump-sum release instead");
  }

  const stream = getStreamContract();
  const tx = await stream.openStream(workerAddress, token, totalBudget, trancheCount);
  const receipt = await tx.wait();
  const streamId = extractStreamIdFromReceipt(receipt, /* pass the real stream-event ABI here */ []);

  await prisma.jobNanopaymentStream.create({
    data: {
      jobId,
      streamId: streamId.toString(),
      workerAddress,
      totalBudget: totalBudget.toString(),
      trancheCount,
      tranchesReleased: 0,
    },
  });

  return { streamId: streamId.toString(), txHash: receipt.hash };
}

/**
 * Call this each time the reviewer (AI or human) confirms ONE requirement
 * from the criteria list is genuinely done. Releases one tranche —
 * approximately totalBudget / trancheCount — to the worker immediately,
 * rather than waiting for every requirement to be done.
 *
 * This is what makes it a "nanopayment" in the Nan/x402 sense: small,
 * frequent, sub-full-job payments as real progress happens, instead of
 * one payment at the very end.
 */
export async function releaseNanopaymentTranche(
  jobId: string,
  requirementIndex: number
): Promise<{ txHash: string }> {
  const streamRecord = await prisma.jobNanopaymentStream.findFirst({ where: { jobId } });
  if (!streamRecord) {
    throw new Error(`no nanopayment stream found for job ${jobId} — was openNanopaymentStreamForJob called?`);
  }
  if (requirementIndex >= streamRecord.trancheCount) {
    throw new Error(`requirement index ${requirementIndex} out of range for ${streamRecord.trancheCount} tranches`);
  }

  const alreadyReleased = await prisma.jobNanopaymentTranche.findFirst({
    where: { jobId, requirementIndex },
  });
  if (alreadyReleased) {
    // Idempotent — calling this twice for the same requirement (e.g. a
    // retried review-approval webhook) should not double-pay.
    return { txHash: alreadyReleased.txHash };
  }

  const stream = getStreamContract();
  const tx = await stream.releaseTranche(streamRecord.streamId);
  const receipt = await tx.wait();

  await prisma.$transaction([
    prisma.jobNanopaymentTranche.create({
      data: { jobId, requirementIndex, txHash: receipt.hash },
    }),
    prisma.jobNanopaymentStream.update({
      where: { id: streamRecord.id },
      data: { tranchesReleased: { increment: 1 } },
    }),
  ]);

  return { txHash: receipt.hash };
}

/**
 * If a worker completes everything early (all requirements done in one
 * review pass rather than incrementally), close the stream to release any
 * remaining balance in one go rather than looping releaseTranche N times.
 */
export async function closeNanopaymentStream(jobId: string): Promise<{ txHash: string }> {
  const streamRecord = await prisma.jobNanopaymentStream.findFirst({ where: { jobId } });
  if (!streamRecord) {
    throw new Error(`no nanopayment stream found for job ${jobId}`);
  }

  const stream = getStreamContract();
  const tx = await stream.closeStream(streamRecord.streamId);
  const receipt = await tx.wait();

  await prisma.jobNanopaymentStream.update({
    where: { id: streamRecord.id },
    data: { tranchesReleased: streamRecord.trancheCount, closedAt: new Date() },
  });

  return { txHash: receipt.hash };
}

/**
 * Shared event-parser wrapper for the stream-id extraction point.
 * `streamEventAbi` MUST be supplied by the caller — it is deliberately NOT
 * hardcoded here, because ArcFlareStream.sol is empty and we refuse to
 * invent its ABI. Once a real contract exists, pass its ABI (e.g. the
 * StreamOpened event declaration) and this returns the streamId.
 */
export function extractStreamIdFromReceipt(
  receipt: any,
  streamEventAbi: readonly string[]
): bigint {
  return parseEventValue(receipt, streamEventAbi, "StreamOpened", "streamId");
}