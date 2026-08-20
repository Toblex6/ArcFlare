// src/lib/agents/agentPay.ts
//
// Agent-to-agent payment execution (roadmap: agent payments). Boundary rule
// from docs/settlement-architecture.md: direct on-chain settlement (Jobs
// pattern) is canonical for agent-to-agent structured payments with on-chain
// state — this is NOT an x402 route (no 402 challenge, no Gateway batch).
// Agent-initiated M2M payments (brain/nano/marketplace) already run through
// withGateway() — this module covers the A2A leg only.
//
// Wallet: the payer agent's per-agent x402 EOA (X402EoaWallet keyed by
// agentRegistryId — same AES-256-GCM-at-rest pattern as merchant buyer
// wallets). Settlement: a NATIVE value-send from that EOA.
//
// Why native sends: measured 2026-08-18 (scripts/repro-balance-views.mjs,
// 14/14) — Arc's native USDC and the ERC-20 interface are ONE asset (18 vs 6
// decimal views of the same balance), and native value-sends are FEE-FREE
// (cost = amount + gas only), while ERC-20-interface transfers charge a
// per-target fee (0.001028 to one EOA, 0.001712 to another, ~0.2% to the
// swap pool, ~12% to the payroll contract). So the transfer mechanism here
// is the one that costs exactly `amount` to the sender and credits exactly
// `amount` to the recipient — no fee-rate assumption anywhere in the code.
//
// Spend-limit order of operations (adapted from fundPayrollViaX402):
//   1. pre-flight checkSpendAllowed() BEFORE any funds move — an over-cap
//      agent gets a clean 403 and nothing happens;
//   2. checkAndRecordSpend() — the on-chain enforcement runs BEFORE the
//      transfer. Unlike payroll (where settle lands funds in the relayer's
//      control and a race failure can be auto-refunded), an A2A transfer is
//      irreversible — the recipient is external. So the cap is enforced
//      first: a race-failure here means the transfer never happens (safe),
//      and the only failure mode is a transfer that reverts AFTER the record
//      (e.g. balance drained by a concurrent spend) — that inflates
//      spentInWindow until the window resets (conservative, self-healing)
//      and is flagged in StuckSettlement PENDING_REVIEW for transparency;
//   3. native value-send from the agent EOA;
//   4. delta verification — recipient balanceOf read at the receipt block
//      must show a credit >= amount (EOA recipients credit exactly; a
//      contract recipient may short up to ~0.005 USDC — the observation
//      window is an explicit tolerance band, never a fee-rate assumption);
//   5. PaymentLog SUCCESS with the real arcTxHash.

import { NextRequest, NextResponse } from "next/server";
import { Contract, JsonRpcProvider, Wallet, parseUnits, parseEther } from "ethers";
import { prisma } from "@/lib/prisma";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { checkSpendAllowed, getSpendLimitContract } from "@/lib/agents/spendLimitEnforcer";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { enqueueForReview } from "@/lib/jobs/settlementRecovery";
import { getUsdcAddress } from "@/lib/tokens/supportedTokens";

const USDC_ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/** Upper bound for a single A2A transfer (1,000,000 USDC). */
const MAX_AMOUNT = 1_000_000n * 1_000_000n;

/**
 * Returns the provider used for on-chain reads/sends in this module.
 * A fresh provider per call avoids sharing cached RPC state across the
 * dev-server hot reload and keeps testnet flakes isolated to this path.
 */
function getProvider(): JsonRpcProvider {
  return new JsonRpcProvider(process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network");
}

export interface AgentPayResult {
  success: boolean;
  agentEoa: string;
  to: string;
  amount: string; // decimal USDC, 6-decimals — the amount the recipient must receive
  txHash?: string;
  recipientCredit?: string; // measured on-chain credit (6-dec)
  error?: string;
  recoveryId?: string;
}

/**
 * Executes an agent-to-agent payment: resolve the payer agent's EOA, prove
 * the caller controls it, spend-limit pre-flight, on-chain record, native
 * transfer, then verify the recipient's real on-chain credit delta.
 */
export async function executeAgentToAgentPayment(req: NextRequest, agentId: number, body: any): Promise<NextResponse> {
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) {
    return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  }

  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return NextResponse.json({ error: "a valid recipient address is required (to)" }, { status: 400 });
  }
  const rawAmount = typeof body?.amount === "string" || typeof body?.amount === "number" ? String(body.amount) : "";
  if (!/^\d+(\.\d{1,6})?$/.test(rawAmount) || parseFloat(rawAmount) <= 0) {
    return NextResponse.json({ error: `invalid amount: ${body?.amount} — use a decimal USDC amount like "0.05"` }, { status: 400 });
  }
  const amount = parseUnits(rawAmount, 6);
  if (amount > MAX_AMOUNT) {
    return NextResponse.json({ error: `amount too large — max ${Number(MAX_AMOUNT) / 1e6} USDC` }, { status: 400 });
  }
  const token = body?.token ? String(body.token) : getUsdcAddress();
  if (token.toLowerCase() !== getUsdcAddress().toLowerCase()) {
    return NextResponse.json({ error: `unsupported token ${token} — agent payments use native USDC` }, { status: 400 });
  }

  // ── M9 idempotency: a retried POST with the same idempotencyKey must
  // replay the ORIGINAL outcome — never spend again (and never burn the
  // spend-limit window twice). The unique PaymentLog.idempotencyKey claim
  // is taken BEFORE the spend record; a concurrent duplicate hits P2002
  // and replays the winner's row.
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 120) : "";
  let claimedLogId: string | null = null;

  const replay = (row: any): NextResponse => {
    if (row.status === "SUCCESS" && row.arcTxHash) {
      return NextResponse.json({
        success: true,
        replayed: true,
        agentId,
        agentEoa: row.senderEmail,
        amount: row.amount,
        txHash: row.arcTxHash,
        message: `Replay of agent payment (original tx ${row.arcTxHash}).`,
      });
    }
    if (row.status === "SETTLEMENT_ERROR") {
      return NextResponse.json(
        {
          error: "Agent payment previously failed during execution — retry with a NEW idempotency key.",
          priorStatus: row.status,
          txHash: row.arcTxHash ?? null,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Agent payment with this idempotency key is already in progress." },
      { status: 409 }
    );
  };

  if (idempotencyKey) {
    const existing = await (prisma as any).paymentLog.findUnique({ where: { idempotencyKey } }).catch(() => null);
    if (existing) return replay(existing);
    try {
      const claim = await (prisma as any).paymentLog.create({
        data: {
          reference: `agentpay_idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          idempotencyKey,
          amount: Number(amount) / 1e6,
          currency: "USDC",
          chain: "Arc Testnet",
          senderEmail: "pending-agent-pay",
          merchant: agent.name,
          agentSCA: agent.scaAddress ?? null,
          direction: "send",
          status: "PENDING",
        },
      });
      claimedLogId = claim.id;
    } catch (claimError: any) {
      if (claimError?.code === "P2002") {
        const winner = await (prisma as any).paymentLog.findUnique({ where: { idempotencyKey } }).catch(() => null);
        if (winner) return replay(winner);
      }
      throw claimError;
    }
  }

  // 1. the payer agent's payment EOA (auto-provisioned, key encrypted at rest).
  const wallet = await getOrCreateAgentWallet(agentId);
  const agentEoa = wallet.address;

  // 2. the caller must control the agent (its SCA, or its payment EOA).
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? agentEoa);
  if (!actor) {
    return NextResponse.json({ error: "This merchant account does not control this agent." }, { status: 403 });
  }

  const provider = getProvider();
  const usdc = new Contract(getUsdcAddress(), USDC_ERC20_ABI, provider);
  const amountNative = parseEther(rawAmount); // native sends are 18-dec — same asset

  // 3. spend-limit PRE-FLIGHT — before any funds move.
  const spendCheck = await checkSpendAllowed({ agentAddress: agentEoa, amount });
  if (!spendCheck.allowed) {
    return NextResponse.json(
      { error: `Agent spend limit rejected: ${spendCheck.reason}. No payment was taken.` },
      { status: 403 }
    );
  }

  // 4. on-chain enforcement BEFORE the transfer (the cap can never be
  // exceeded by this route: a revert here means no payment happens).
  const spendLimit = getSpendLimitContract();
  let recordTxHash: string;
  try {
    const recordTx = await spendLimit.checkAndRecordSpend(agentEoa, amount);
    await recordTx.wait();
    recordTxHash = recordTx.hash;
  } catch (recordError: any) {
    return NextResponse.json(
      {
        error: "Agent spend limit race: on-chain record failed before the transfer.",
        detail: `No payment was taken. ${recordError?.message ?? "checkAndRecordSpend reverted"}`,
      },
      { status: 409 }
    );
  }

  // 5. native value-send (fee-free, credits the recipient exactly).
  const agentWallet = new Wallet(wallet.privateKey, provider);
  const beforeRecipient = await usdc.balanceOf(to);
  let receipt: any = null;
  try {
    const tx = await agentWallet.sendTransaction({ to, value: amountNative });
    receipt = await tx.wait();
  } catch (sendError: any) {
    // Money never moved (recorded spend is the only side effect) — flag the
    // conservative lockout for review and tell the caller to retry next window.
    const recoveryId = await enqueueForReview({
      agentAddress: agentEoa,
      amount,
      jobCriteriaId: `agent-pay:${agentId}:${to}`,
      gatewayRef: "none",
      settlementTxHash: recordTxHash,
      failureReason: `transfer reverted after spend record: ${sendError?.message ?? "revert"}`,
    });
const errorRow: any = {
      amount: Number(amount) / 1e6,
      currency: "USDC",
      chain: "Arc Testnet",
      senderEmail: agentEoa,
      merchant: agent.name,
      agentSCA: agent.scaAddress ?? null,
      direction: "send",
      status: "SETTLEMENT_ERROR",
      arcTxHash: null,
    };
    if (claimedLogId) {
      prisma.paymentLog
        .update({ where: { id: claimedLogId }, data: errorRow })
        .catch((e: any) => console.error("[agentPay] error log update failed:", e.message));
    } else {
      prisma.paymentLog
        .create({
          data: {
            reference: `agentpay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            ...errorRow,
          },
        })
        .catch((e: any) => console.error("[agentPay] error log row failed:", e.message));
    }
    return NextResponse.json(
      {
        error: "Agent payment transfer failed after the spend record.",
        detail: `The spend was recorded on-chain (tx ${recordTxHash}) but the transfer reverted. The recorded spend resets when the window resets. Review record: ${recoveryId}.`,
        recoveryId,
      },
      { status: 500 }
    );
  }

  // 6. delta verification — the recipient's REAL on-chain credit at the
  // receipt block. EOA recipients credit exactly `amount`; a contract
  // recipient may short up to ~0.005 USDC (measured shortfall band, not a
  // fee-rate assumption — anything beyond the band is flagged, not assumed).
  const afterRecipient = await usdc.balanceOf(to, { blockTag: receipt.blockNumber });
  const credit = afterRecipient - beforeRecipient;
  const creditOk = credit >= amount - 5_000n; // 0.005 USDC tolerance band
  if (!creditOk) {
    const recoveryId = await enqueueForReview({
      agentAddress: agentEoa,
      amount,
      jobCriteriaId: `agent-pay:${agentId}:${to}`,
      gatewayRef: "none",
      settlementTxHash: receipt.hash,
      failureReason: `recipient credit ${Number(credit) / 1e6} USDC < amount ${Number(amount) / 1e6} USDC (delta check failed)`,
    });
const creditErrorRow: any = {
      amount: Number(amount) / 1e6,
      currency: "USDC",
      chain: "Arc Testnet",
      senderEmail: agentEoa,
      merchant: agent.name,
      agentSCA: agent.scaAddress ?? null,
      direction: "send",
      status: "SETTLEMENT_ERROR",
      arcTxHash: receipt.hash,
    };
    if (claimedLogId) {
      prisma.paymentLog
        .update({ where: { id: claimedLogId }, data: creditErrorRow })
        .catch((e: any) => console.error("[agentPay] error log update failed:", e.message));
    } else {
      prisma.paymentLog
        .create({
          data: {
            reference: `agentpay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            ...creditErrorRow,
          },
        })
        .catch((e: any) => console.error("[agentPay] error log row failed:", e.message));
    }
    return NextResponse.json(
      {
        error: "Agent payment sent but recipient credit verification failed.",
        detail: `Transfer ${receipt.hash} landed but the recipient's on-chain balance did not increase by the expected amount. Review record: ${recoveryId}.`,
        txHash: receipt.hash,
        recoveryId,
      },
      { status: 409 }
    );
  }

// 7. ledger row — SUCCESS with the real on-chain hash (or update the
  // idempotency claim with the final outcome).
  const successRow: any = {
    amount: Number(amount) / 1e6,
    currency: "USDC",
    chain: "Arc Testnet",
    senderEmail: agentEoa,
    merchant: agent.name,
    agentSCA: agent.scaAddress ?? null,
    direction: "send",
    status: "SUCCESS",
    arcTxHash: receipt.hash,
    gatewayReference: recordTxHash,
  };
  if (claimedLogId) {
    prisma.paymentLog
      .update({ where: { id: claimedLogId }, data: successRow })
      .catch((e: any) => console.error("[agentPay] success log update failed:", e.message));
  } else {
    prisma.paymentLog
      .create({
        data: {
          reference: `agentpay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          ...successRow,
        },
      })
      .catch((e: any) => console.error("[agentPay] success log row failed:", e.message));
  }

  return NextResponse.json({
    success: true,
    replayed: false,
    agentId,
    agentEoa,
    to,
    amount: rawAmount,
    txHash: receipt.hash,
    recipientCredit: (Number(credit) / 1e6).toFixed(6),
    spendRecordTx: recordTxHash,
    idempotencyKey: idempotencyKey || undefined,
    message: `Agent ${agent.name} paid ${rawAmount} USDC to ${to}.`,
  });
}

/**
 * Reads the agent's current on-chain spend policy (cap, window, spent).
 * Caller must control the agent — the policy response reveals the agent's
 * payment EOA, which is the exact handle an attacker would need to front-run
 * the limit's bootstrap slot, so it is not public.
 */
export async function getAgentPolicy(req: NextRequest, agentId: number): Promise<NextResponse> {
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) {
    return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  }
  const wallet = await getOrCreateAgentWallet(agentId);
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? wallet.address);
  if (!actor) {
    return NextResponse.json({ error: "This merchant account does not control this agent." }, { status: 403 });
  }
  const limit = await getSpendLimitContract().getLimit(wallet.address);
  return NextResponse.json({
    agentId,
    agentEoa: wallet.address,
    capPerWindow: limit ? Number(limit.capPerWindow) / 1e6 : 0,
    windowSeconds: limit ? Number(limit.windowSeconds) : 0,
    spentInWindow: limit ? Number(limit.spentInWindow) / 1e6 : 0,
    windowStart: limit ? Number(limit.windowStart) : 0,
    active: limit ? limit.active : false,
    owner: limit ? limit.owner : null,
  });
}

/**
 * Sets the agent's spend policy (ArcFlareSpendLimit.setLimit). The contract
 * itself is owner-gated (only the first caller / current owner can set a
 * limit for an agent); the route additionally requires the caller to control
 * the agent.
 */
export async function setAgentPolicy(req: NextRequest, agentId: number, body: any): Promise<NextResponse> {
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) {
    return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  }
  const rawCap = typeof body?.capPerWindow === "string" || typeof body?.capPerWindow === "number" ? String(body.capPerWindow) : "";
  if (!/^\d+(\.\d{1,6})?$/.test(rawCap) || parseFloat(rawCap) <= 0) {
    return NextResponse.json({ error: `invalid capPerWindow: ${body?.capPerWindow} — use a decimal USDC amount` }, { status: 400 });
  }
  const windowSeconds = Number(body?.windowSeconds ?? 0);
  if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 30 * 86400) {
    return NextResponse.json({ error: "windowSeconds must be an integer between 60 and 2,592,000" }, { status: 400 });
  }
  const cap = parseUnits(rawCap, 6);

  const wallet = await getOrCreateAgentWallet(agentId);
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? wallet.address);
  if (!actor) {
    return NextResponse.json({ error: "This merchant account does not control this agent." }, { status: 403 });
  }

  // H3 — bootstrap front-run guard: the contract's setLimit is first-caller-
  // becomes-owner. The limit owner must be the platform relayer (which signs
  // every setLimit and is set as owner at wallet provisioning); if someone
  // else already claimed the slot, this merchant's policy change would
  // silently fail on-chain (or, worse, be controlled by the attacker).
  // Refuse loudly instead of reverting opaquely.
  const limit = await getSpendLimitContract().getLimit(wallet.address);
  if (limit?.owner && limit.owner !== "0x0000000000000000000000000000000000000000") {
    const relayer = await getRelayerSigner().getAddress();
    if (limit.owner.toLowerCase() !== relayer.toLowerCase()) {
      return NextResponse.json(
        {
          error: "Spend-limit ownership for this agent was taken by another address — policy changes are disabled for this agent.",
          detail: `On-chain limit owner is ${limit.owner}, expected the platform relayer. Contact support.`,
        },
        { status: 403 }
      );
    }
  }

  const tx = await getSpendLimitContract().setLimit(wallet.address, cap, BigInt(windowSeconds));
  const receipt = await tx.wait();
  return NextResponse.json({
    success: true,
    agentId,
    agentEoa: wallet.address,
    capPerWindow: rawCap,
    windowSeconds,
    txHash: receipt.hash,
    message: `Spend policy set: ${rawCap} USDC per ${windowSeconds}s window.`,
  });
}