// src/lib/jobs/settlementRecovery.ts
//
// Handles the specific race window in the x402 payment paths: x402 settlement
// succeeds (money has moved to the relayer), but checkAndRecordSpend()
// reverts afterward because a concurrent spend from the same agent pushed it
// over the cap in between the pre-flight check and this point. That leaves
// the relayer holding settled funds with no job/batch created.
//
// Policy: AUTO-REFUND back to the agent, then let it retry on its own.
// Chosen over a manual review queue because the failure is caused by the
// agent's own concurrent behavior, not fraud or a system fault — nothing for
// a human to adjudicate, the agent just needs its money back so it can retry
// once its window allows it. (enqueueForReview is provided as the alternative
// policy if that ever changes.)

import { Contract } from "ethers";
import { prisma } from "@/lib/prisma";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { getUsdcAddress } from "@/lib/tokens/supportedTokens";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
];

export interface StuckSettlement {
  agentAddress: string;
  amount: bigint;
  jobCriteriaId: string; // e.g. `payroll:${recipients.length}-recipients` from the failed call
  gatewayRef: string;    // from the x402 settlement, for reconciliation
  settlementTxHash: string;
  failureReason: string; // e.g. the revert reason from checkAndRecordSpend
}

/**
 * Call from the catch block around checkAndRecordSpend(). Records the stuck
 * settlement for audit/reconciliation FIRST (so a refund-transfer failure
 * can't destroy the audit trail), then refunds the agent from the relayer's
 * held balance. Returns the refund tx hash so the caller can surface it in
 * the error response as proof the money is coming back.
 */
export async function recoverFromSpendLimitRaceFailure(
  stuck: StuckSettlement
): Promise<{ refundTxHash: string; recoveryId: string }> {
  const recovery = await prisma.stuckSettlement.create({
    data: {
      agentAddress: stuck.agentAddress,
      amount: stuck.amount.toString(),
      jobCriteriaId: stuck.jobCriteriaId,
      gatewayRef: stuck.gatewayRef,
      settlementTxHash: stuck.settlementTxHash,
      failureReason: stuck.failureReason,
      status: "PENDING_REFUND",
    },
  });

  try {
    const refundTxHash = await autoRefund(stuck.agentAddress, stuck.amount);

    await prisma.stuckSettlement.update({
      where: { id: recovery.id },
      data: { status: "REFUNDED", refundTxHash },
    });

    return { refundTxHash, recoveryId: recovery.id };
  } catch (refundError) {
    await prisma.stuckSettlement.update({
      where: { id: recovery.id },
      data: {
        status: "REFUND_FAILED",
        failureReason: `${stuck.failureReason} | refund attempt also failed: ${(refundError as Error).message}`,
      },
    });

    throw new Error(
      `settlement recovery failed for agent ${stuck.agentAddress}, amount ${stuck.amount} — ` +
      `funds are STILL HELD by the relayer and NOT refunded. Recovery record: ${recovery.id}. ` +
      `This needs manual intervention — check StuckSettlement table.`
    );
  }
}

/**
 * Transfers the stuck amount back to the agent's wallet from the relayer's
 * balance. A plain ERC-20 transfer, not x402 — this is a refund, not a new
 * negotiated payment, so no 402 challenge is needed.
 */
async function autoRefund(agentAddress: string, amount: bigint): Promise<string> {
  const relayerSigner = getRelayerSigner();
  const usdc = new Contract(getUsdcAddress(), ERC20_ABI, relayerSigner);
  const tx = await usdc.transfer(agentAddress, amount);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Alternative policy: queue for manual review instead of auto-refunding.
 * Not called by default — swap this in if a human should look at every
 * occurrence (e.g. early on, while judging how often the race occurs).
 */
export async function enqueueForReview(stuck: StuckSettlement): Promise<string> {
  const recovery = await prisma.stuckSettlement.create({
    data: {
      agentAddress: stuck.agentAddress,
      amount: stuck.amount.toString(),
      jobCriteriaId: stuck.jobCriteriaId,
      gatewayRef: stuck.gatewayRef,
      settlementTxHash: stuck.settlementTxHash,
      failureReason: stuck.failureReason,
      status: "PENDING_REVIEW",
    },
  });
  return recovery.id;
}
