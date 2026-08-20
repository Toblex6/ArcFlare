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
import { prisma } from "@/lib/prisma";

const SPEND_LIMIT_CONTRACT_ADDRESS = process.env.SPEND_LIMIT_CONTRACT_ADDRESS ?? "";

// ── H3 default limit ──────────────────────────────────────────────────────────
// A freshly provisioned agent payment EOA must NEVER sit in the contract's
// "no limit configured = no cap enforced" state (the bootstrap first-caller-
// becomes-owner slot is exactly what an attacker would front-run). Every new
// agent wallet gets an explicit default cap signed by the RELAYER the moment
// it is created — the relayer becomes the limit owner, an attacker can no
// longer bootstrap, and the agent is never uncapped by default. Merchants
// then raise/lower the cap via POST /api/agents/[id]/policy (owner-gated).
// Product decision: 100 USDC per 24h rolling window (fail-safe default; the
// merchant raises it explicitly for larger flows).
export const DEFAULT_AGENT_SPEND_CAP_USDC = 100;
export const DEFAULT_AGENT_SPEND_WINDOW_SECONDS = 24 * 60 * 60;

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

/**
 * H3 — secures the bootstrap slot for a NEW agent payment wallet. Called at
 * provisioning time (getOrCreateAgentWallet creation branch). The relayer
 * signs the default setLimit, so the relayer becomes the on-chain limit
 * owner BEFORE any attacker can call setLimit(agent, ...) first and become
 * owner themselves (the contract's first-caller-wins bootstrap). If the
 * slot was already taken by a non-relayer, the default cannot be applied —
 * that's a front-run and is flagged for review; the setAgentPolicy guard
 * will refuse policy changes for that wallet.
 *
 * Never throws to the caller: provisioning must not fail because the chain
 * is flaky. A failure leaves the wallet without a default (rare, and
 * backstopped by the setAgentPolicy front-run guard), logged loudly.
 */
export async function ensureAgentDefaultSpendLimit(agentAddress: string): Promise<void> {
  try {
    const contract = getSpendLimitContract();
    const limit = await contract.getLimit(agentAddress);
    if (limit?.owner && limit.owner !== "0x0000000000000000000000000000000000000000") {
      const relayer = await getRelayerSigner().getAddress();
      if (limit.owner.toLowerCase() !== relayer.toLowerCase()) {
        console.error(
          `[spendLimitEnforcer] FRONT-RUN: agent ${agentAddress.slice(0, 10)}… limit owner is ${limit.owner}, not the relayer — refusing to touch it.`
        );
        prisma.stuckSettlement
          .create({
            data: {
              agentAddress,
              amount: "0",
              jobCriteriaId: "agent-wallet-provisioning",
              gatewayRef: "none",
              settlementTxHash: "none",
              failureReason: `spend-limit bootstrap front-run: owner is ${limit.owner}, expected the relayer`,
            },
          })
          .catch(() => {});
      }
      return;
    }
    const cap = BigInt(DEFAULT_AGENT_SPEND_CAP_USDC) * 1_000_000n;
    const tx = await contract.setLimit(agentAddress, cap, BigInt(DEFAULT_AGENT_SPEND_WINDOW_SECONDS));
    await tx.wait();
    console.log(
      `[spendLimitEnforcer] default limit set for agent EOA ${agentAddress.slice(0, 10)}… (${DEFAULT_AGENT_SPEND_CAP_USDC} USDC / ${DEFAULT_AGENT_SPEND_WINDOW_SECONDS}s)`
    );
  } catch (e: any) {
    console.error(
      `[spendLimitEnforcer] failed to set default spend limit for ${agentAddress.slice(0, 10)}…: ${e?.message ?? e}`
    );
  }
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

/**
 * Backend bookkeeping AFTER a spend has succeeded on-chain. The on-chain
 * total is already recorded by checkAndRecordSpend() — this writes a durable
 * audit row (PaymentLog) so backend-side queries can see per-agent spend
 * history. Mirrors the role of the dead-code recordSpend (task/counterparty
 * ledgers) without the per-task schema: payroll is a single-funder flow with
 * no taskId/counterparty, so only the on-chain cap layer and this audit row
 * engage — exactly the approved Batch 4-5 design.
 *
 * Fire-and-forget: a failed audit row must never gate the payment outcome.
 */
export async function recordSpend(params: SpendCheckParams): Promise<void> {
  const { agentAddress, amount } = params;
  await prisma.paymentLog
    .create({
      data: {
        reference: `spend_${agentAddress.toLowerCase()}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        amount: Number(amount) / 1e6,
        currency: "USDC",
        chain: "Arc Testnet x402",
        senderEmail: agentAddress,
        merchant: "payroll/x402-spend-record",
        status: "SUCCESS",
        arcTxHash: null,
        gatewayReference: null,
      },
    })
    .catch((e: any) => console.error("[spendLimitEnforcer] recordSpend row failed:", e.message));
}
