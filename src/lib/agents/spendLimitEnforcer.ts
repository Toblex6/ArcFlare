// src/lib/agents/spendLimitEnforcer.ts
//
// LIVE version of the spend-limit pre-flight used to sit in stubs/dead-code/.
// The trust primitive is ArcFlareSpendLimit.sol's on-chain per-address cap:
// nothing a backend bug or compromised API key can bypass. This file is the
// backend-facing pre-flight wrapper around that contract.
//
// Scope note (payroll wiring, Batch 5): only the on-chain cap layer engages
// for payroll — fundPayrollViaX402 passes no taskId/counterparty, so the
// per-task/per-counterparty backend caps documented in the dead-code version
// are intentionally not re-created here (no schema for them, and payroll is a
// single-funder flow). If those are ever needed again, they go on top of this
// file without touching the contract.

import { Contract } from "ethers";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";

const SPEND_LIMIT_CONTRACT_ADDRESS = process.env.SPEND_LIMIT_CONTRACT_ADDRESS ?? "";

const SPEND_LIMIT_ABI = [
  "function wouldExceedLimit(address agent, uint256 amount) external view returns (bool)",
  "function checkAndRecordSpend(address agent, uint256 amount) external",
  "function getLimit(address agent) external view returns (tuple(uint256 capPerWindow,uint256 windowSeconds,uint256 windowStart,uint256 spentInWindow,address owner,bool active))",
  "function setLimit(address agent, uint256 capPerWindow, uint256 windowSeconds) external",
];

export function getSpendLimitContract(): Contract {
  if (!SPEND_LIMIT_CONTRACT_ADDRESS) {
    throw new Error("SPEND_LIMIT_CONTRACT_ADDRESS is not configured — deploy ArcFlareSpendLimit.sol first");
  }
  return new Contract(SPEND_LIMIT_CONTRACT_ADDRESS, SPEND_LIMIT_ABI, getRelayerSigner());
}

export interface SpendCheckParams {
  agentAddress: string;
  amount: bigint;
}

export interface SpendCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Pre-flight — call BEFORE the agent's payment moves (before x402 settlement,
 * so an over-cap agent gets a clean rejection instead of pay-then-fail).
 * `wouldExceedLimit` is a view call; no state changes.
 */
export async function checkSpendAllowed(params: SpendCheckParams): Promise<SpendCheckResult> {
  const { agentAddress, amount } = params;

  const contract = getSpendLimitContract();
  const wouldExceed: boolean = await contract.wouldExceedLimit(agentAddress, amount);
  if (wouldExceed) {
    const limit = await contract.getLimit(agentAddress);
    const cap = limit?.capPerWindow ?? 0n;
    const windowSeconds = limit?.windowSeconds ?? 0n;
    return {
      allowed: false,
      reason: `would exceed agent's on-chain spending cap (cap ${cap} per ${windowSeconds}s window)`,
    };
  }

  return { allowed: true };
}
