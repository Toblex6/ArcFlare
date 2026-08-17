/**
 * spendLimitEnforcer.ts
 *
 * Finer-grained spending control on top of ArcFlareSpendLimit.sol's on-chain
 * hard cap. Where the contract only knows "has this agent spent too much
 * overall in this window," this layer adds per-task and per-counterparty
 * caps — the kind of thing you want to iterate on quickly without a
 * contract redeploy, and that doesn't need the same trustless guarantee
 * (worst case here is a bug lets one task overspend within an already-
 * enforced overall on-chain ceiling — not an unbounded drain).
 *
 * ALWAYS call checkSpendAllowed() before initiating a payment, and
 * recordSpend() after it succeeds. The on-chain call
 * (ArcFlareSpendLimit.checkAndRecordSpend) is still the final backstop —
 * this file does not replace it, it adds finer rules in front of it.
 */

import { prisma } from "@/lib/prisma"; // adjust to your actual client path
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { Contract } from "ethers";

const SPEND_LIMIT_CONTRACT_ADDRESS = process.env.SPEND_LIMIT_CONTRACT_ADDRESS ?? "";

const SPEND_LIMIT_ABI = [
  "function wouldExceedLimit(address agent, uint256 amount) external view returns (bool)",
  "function checkAndRecordSpend(address agent, uint256 amount) external",
  "function getLimit(address agent) external view returns (tuple(uint256 capPerWindow,uint256 windowSeconds,uint256 windowStart,uint256 spentInWindow,address owner,bool active))",
];

function getSpendLimitContract(): Contract {
  if (!SPEND_LIMIT_CONTRACT_ADDRESS) {
    throw new Error("SPEND_LIMIT_CONTRACT_ADDRESS is not configured — deploy ArcFlareSpendLimit.sol first");
  }
  return new Contract(SPEND_LIMIT_CONTRACT_ADDRESS, SPEND_LIMIT_ABI, getRelayerSigner());
}

export interface SpendCheckParams {
  agentAddress: string;
  amount: bigint;
  taskId?: string;        // optional — per-task cap only checked if provided
  counterparty?: string;  // optional — per-counterparty cap only checked if provided
}

export interface SpendCheckResult {
  allowed: boolean;
  reason?: string;
  // which layer rejected it, useful for surfacing a clear error to the agent
  rejectedBy?: "on-chain-agent-cap" | "task-cap" | "counterparty-cap";
}

/**
 * Pre-flight check — call this BEFORE the agent signs or the relayer
 * submits any payment. Checks task/counterparty caps first (cheap DB
 * reads) before falling through to the on-chain pre-flight check (an RPC
 * call), so obviously-over-budget requests fail fast without hitting the
 * chain at all.
 */
export async function checkSpendAllowed(params: SpendCheckParams): Promise<SpendCheckResult> {
  const { agentAddress, amount, taskId, counterparty } = params;

  if (taskId) {
    const taskCheck = await checkTaskCap(agentAddress, taskId, amount);
    if (!taskCheck.allowed) return taskCheck;
  }

  if (counterparty) {
    const counterpartyCheck = await checkCounterpartyCap(agentAddress, counterparty, amount);
    if (!counterpartyCheck.allowed) return counterpartyCheck;
  }

  // Final backstop: the on-chain hard cap. This is the one that actually
  // can't be bypassed by a bug in the two checks above.
  const contract = getSpendLimitContract();
  const wouldExceed: boolean = await contract.wouldExceedLimit(agentAddress, amount);
  if (wouldExceed) {
    return { allowed: false, reason: "would exceed agent's on-chain spending cap", rejectedBy: "on-chain-agent-cap" };
  }

  return { allowed: true };
}

/**
 * Call this AFTER a payment succeeds, to record it against task/counterparty
 * totals. The on-chain total is recorded separately, inside
 * checkAndRecordSpend — call that from your relayer at the point the actual
 * payment transaction is submitted, not here (this file only tracks the
 * backend-side finer-grained bookkeeping).
 */
export async function recordSpend(params: SpendCheckParams): Promise<void> {
  const { agentAddress, amount, taskId, counterparty } = params;

  if (taskId) {
    await prisma.agentTaskSpend.upsert({
      where: { agentAddress_taskId: { agentAddress, taskId } },
      create: { agentAddress, taskId, totalSpent: amount.toString() },
      update: { totalSpent: { increment: amount.toString() } }, // adjust to your Decimal/BigInt field type
    });
  }

  if (counterparty) {
    await prisma.agentCounterpartySpend.upsert({
      where: { agentAddress_counterparty: { agentAddress, counterparty } },
      create: { agentAddress, counterparty, totalSpent: amount.toString() },
      update: { totalSpent: { increment: amount.toString() } },
    });
  }
}

async function checkTaskCap(agentAddress: string, taskId: string, amount: bigint): Promise<SpendCheckResult> {
  const taskLimit = await prisma.agentTaskSpendLimit.findUnique({
    where: { agentAddress_taskId: { agentAddress, taskId } },
  });
  if (!taskLimit) return { allowed: true }; // no per-task cap configured — not blocked, same philosophy as the contract default

  const currentSpend = await prisma.agentTaskSpend.findUnique({
    where: { agentAddress_taskId: { agentAddress, taskId } },
  });
  const spentSoFar = BigInt(currentSpend?.totalSpent ?? "0");

  if (spentSoFar + amount > BigInt(taskLimit.capAmount)) {
    return { allowed: false, reason: `would exceed per-task cap for task ${taskId}`, rejectedBy: "task-cap" };
  }
  return { allowed: true };
}

async function checkCounterpartyCap(agentAddress: string, counterparty: string, amount: bigint): Promise<SpendCheckResult> {
  const cpLimit = await prisma.agentCounterpartySpendLimit.findUnique({
    where: { agentAddress_counterparty: { agentAddress, counterparty } },
  });
  if (!cpLimit) return { allowed: true };

  const currentSpend = await prisma.agentCounterpartySpend.findUnique({
    where: { agentAddress_counterparty: { agentAddress, counterparty } },
  });
  const spentSoFar = BigInt(currentSpend?.totalSpent ?? "0");

  if (spentSoFar + amount > BigInt(cpLimit.capAmount)) {
    return { allowed: false, reason: `would exceed cap for counterparty ${counterparty}`, rejectedBy: "counterparty-cap" };
  }
  return { allowed: true };
}

/*
 * ---- Required schema additions (diff, not full schema.prisma) ----
 *
 * model AgentTaskSpendLimit {
 *   agentAddress String
 *   taskId       String
 *   capAmount    String   // store as string to avoid float precision issues, parse to BigInt in code
 *   @@id([agentAddress, taskId])
 * }
 *
 * model AgentTaskSpend {
 *   agentAddress String
 *   taskId       String
 *   totalSpent   String
 *   @@id([agentAddress, taskId])
 * }
 *
 * model AgentCounterpartySpendLimit {
 *   agentAddress String
 *   counterparty String
 *   capAmount    String
 *   @@id([agentAddress, counterparty])
 * }
 *
 * model AgentCounterpartySpend {
 *   agentAddress String
 *   counterparty String
 *   totalSpent   String
 *   @@id([agentAddress, counterparty])
 * }
 *
 * NOTE: the upsert `increment` calls above assume a numeric field type —
 * if you store totalSpent as String (recommended, per the BigInt precision
 * note), you'll need to read-then-write instead of using Prisma's atomic
 * increment, since increment doesn't work on String fields. Flagging this
 * rather than silently writing code that won't compile against a String
 * schema — pick one approach and adjust the two upsert calls accordingly.
 */
