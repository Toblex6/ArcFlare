// src/lib/payroll/payrollExecution.ts
//
// Live wiring for ArcFlarePayroll.sol funding, revived from the dead-code
// version in stubs/dead-code/payrollExecution.ts and re-wired against the
// CURRENT x402 middleware (src/lib/x402.ts).
//
// What was stale in the dead-code version:
//   - it called `withGateway({ payerAddress, tokenAddress, amount, memo })`
//     as a standalone settlement helper — the current withGateway() is a
//     route wrapper (handler, price, endpoint) that returns NextResponse;
//     there is no options-object form. fundPayrollViaX402 now uses the
//     shared primitives the current middleware itself is built on:
//     paymentRequiredResponse / verifyPayment / settlePayment — the 402
//     challenge format stays byte-identical to every other x402 route.
//   - it imported verifyCallerControlsAddress from the old auth path and
//     recordSpend/checkSpendAllowed from the dead-code enforcer; those now
//     live at @/lib/wallet/verifyCallerControlsAddress and
//     @/lib/agents/spendLimitEnforcer with their current signatures.
//   - it assumed x402 settlement leaves the relayer EOA holding the funds.
//     Settlement actually lands in the SELLER's gateway wallet, so the
//     settled amount is swept to the relayer EOA (GatewayClient.withdraw,
//     same pattern as /api/x402/seller/balance/withdraw) before the batch
//     is funded — otherwise fundBatchFor would revert on an empty balance.
//
// Spend-limit wiring (matches x402JobPayment.ts's fundJobViaX402 exactly):
//   1. pre-flight checkSpendAllowed() BEFORE settlement — an over-cap
//      merchant gets a clean 403 and no payment is taken;
//   2. settlePayment() — funds move to the seller gateway, then swept to
//      the relayer EOA;
//   3. checkAndRecordSpend() — the on-chain enforcement. A concurrent
//      spend pushing the merchant over cap in the race window reverts
//      here; recoverFromSpendLimitRaceFailure() auto-refunds the settled
//      amount (same recovery mechanism job funding uses — not a new one);
//   4. recordSpend() — backend audit bookkeeping.
//
// Returns a NextResponse in every path (like withGateway), so the route is
// a thin wrapper: export const POST = withApiKeyOrAnySession(handler) where
// the handler validates the body and calls this.

import { NextRequest, NextResponse } from "next/server";
import { Contract } from "ethers";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { prisma } from "@/lib/prisma";
import { paymentRequiredResponse, verifyPayment, settlePayment } from "@/lib/x402";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { checkSpendAllowed, getSpendLimitContract, recordSpend } from "@/lib/agents/spendLimitEnforcer";
import { recoverFromSpendLimitRaceFailure, enqueueForReview } from "@/lib/jobs/settlementRecovery";
import { getTokenBySymbol, isSupportedToken, getUsdcAddress, getTokenByAddress } from "@/lib/tokens/supportedTokens";
import { parseEventValue } from "@/lib/contracts/receiptParser";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";

const PAYROLL_CONTRACT_ADDRESS = process.env.PAYROLL_CONTRACT_ADDRESS ?? "";

// ── H10: sweep serialization ─────────────────────────────────────────────────
// The seller-gateway balance is a shared pool: every settlement from every
// payer lands there, and each fundPayrollViaX402 call sweeps ITS amount out
// to the relayer. Two concurrent sweeps polling `totalBalance >= amount`
// could each believe their credit landed, and the second withdraw would
// then take funds that belong to the OTHER settlement (or revert, stranding
// the first settlement). A module-level mutex serializes the whole
// poll→withdraw sequence so exactly one sweep reads the balance at a time,
// and the withdraw amount stays tied to THIS settlement's price.
let sweepChain: Promise<unknown> = Promise.resolve();

function serializeSweep<T>(fn: () => Promise<T>): Promise<T> {
  const run = sweepChain.then(fn, fn);
  sweepChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface SweepResult {
  mintTxHash: string;
  balanceBefore: string; // seller gateway totalBalance (6-dec units) before withdraw
  balanceAfter: string; // after withdraw — attribution delta for audit
}

const ENDPOINT = "/api/payroll/fund";
const MAX_RECIPIENTS = 200; // mirrors the on-chain cap in ArcFlarePayroll._createBatch

const PAYROLL_ABI = [
  "function fundBatchFor(address merchant, address token, address[] recipients, uint256[] amounts) external returns (uint256 batchId)",
  "function executeBatch(uint256 batchId) external",
  "function cancelBatch(uint256 batchId) external",
  "event BatchFunded(uint256 indexed batchId, address indexed merchant, address token, uint256 totalFunded, uint32 recipientCount)",
  "event BatchCompleted(uint256 indexed batchId, uint256 totalPaidOut)",
];

function getPayrollContract(): Contract {
  if (!PAYROLL_CONTRACT_ADDRESS) {
    throw new Error("PAYROLL_CONTRACT_ADDRESS is not configured — deploy ArcFlarePayroll.sol first");
  }
  return new Contract(PAYROLL_CONTRACT_ADDRESS, PAYROLL_ABI, getRelayerSigner());
}

/**
 * Ensures the payroll contract can pull the batch total from the relayer EOA.
 * fundBatchFor transfers token from the relayer (msg.sender is not the
 * spender), so a standing allowance from the relayer is required. Self-heals:
 * if the allowance is below the batch total, approves exactly the remaining
 * need (not max) and waits for the tx to land before funding.
 */
async function ensurePayrollAllowance(payer: string, tokenAddress: string, amounts: bigint[]): Promise<void> {
  const total = amounts.reduce((sum, a) => sum + a, 0n);
  if (total === 0n) return;
  const relayer = getRelayerSigner();
  const token = new Contract(tokenAddress, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], relayer);
  const current = await token.allowance(await relayer.getAddress(), PAYROLL_CONTRACT_ADDRESS);
  if (current >= total) return;
  const approveTx = await token.approve(PAYROLL_CONTRACT_ADDRESS, total);
  await approveTx.wait();
  const allowanceSymbol = getTokenByAddress(tokenAddress)?.symbol ?? 'tokens';
  console.log(`[payroll/fund] approved ${Number(total) / 1e6} ${allowanceSymbol} for payroll (payer ${payer.slice(0, 8)}…)`);
}

export interface PayrollRecipient {
  address: string;
  amount: bigint; // base units (6 decimals)
}

/**
 * Sweeps the just-settled amount from the seller's gateway wallet to the
 * relayer EOA, which is the wallet that signs fundBatchFor. Same pattern as
 * /api/x402/seller/balance/withdraw (GatewayClient.withdraw, instant
 * same-chain mint).
 *
 * Circle executes settlement ASYNCHRONOUSLY on their backend (the /settle
 * call only returns a batch reference), so the seller's on-chain gateway
 * balance is polled until the credit lands — typically within a minute —
 * before withdrawing. A timeout yields a clear error instead of a silent
 * race.
 */
async function sweepSettledToRelayer(price: string): Promise<SweepResult> {
  const sellerPrivateKey = process.env.SELLER_PRIVATE_KEY;
  if (!sellerPrivateKey) {
    throw new Error("SELLER_PRIVATE_KEY not configured — cannot sweep settled funds to the relayer");
  }
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: sellerPrivateKey as `0x${string}`,
  });
  const sellerEoa = new (await import("ethers")).Wallet(sellerPrivateKey).address;

  const amountUnits = BigInt(Math.round(parseFloat(price) * 1_000_000));
  const provider = new (await import("ethers")).JsonRpcProvider(process.env.ARC_TESTNET_RPC);
  const batching = new (await import("ethers")).Contract(
    "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    ["function totalBalance(address token, address depositor) view returns (uint256)"],
    provider
  );
  const usdc = getUsdcAddress();

  return serializeSweep(async (): Promise<SweepResult> => {
    // Re-read under the lock: another sweep can no longer race us, so the
    // balance we see is the real, attributable state.
    const balanceBefore = BigInt(await batching.totalBalance(usdc, sellerEoa));

    const deadline = Date.now() + 120_000; // Circle settles in backend batches; wait up to 2 min
    let credited = false;
    while (Date.now() < deadline) {
      const total = BigInt(await batching.totalBalance(usdc, sellerEoa));
      if (total >= amountUnits) {
        credited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!credited) {
      throw new Error(`settled amount not credited to seller gateway wallet (${sellerEoa}) within 120s`);
    }

    const result = await gateway.withdraw(price, {
      chain: "arcTestnet",
      recipient: (await getRelayerSigner().getAddress()) as `0x${string}`,
    });

    // Attribution delta — the balance right after the withdraw. The sweep
    // took exactly `price`; anything else arriving/leaving concurrently is
    // visible here for the audit trail (payrollBatch results), never
    // assumed away.
    const balanceAfter = BigInt(await batching.totalBalance(usdc, sellerEoa));
    return {
      mintTxHash: result.mintTxHash,
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
    };
  });
}

/**
 * Funds a payroll batch via x402 settlement, spend-limit enforced end to
 * end (order of operations in the file header). Returns a NextResponse in
 * every path; the success body carries batchId/txHash/gatewayRef for the
 * client, and the PAYMENT-RESPONSE header is set for the GatewayClient.
 */
export async function fundPayrollViaX402(
  req: NextRequest,
  recipients: PayrollRecipient[],
  token?: string
): Promise<NextResponse> {
  const tokenAddress = token ?? getUsdcAddress();
  if (recipients.length === 0) {
    return NextResponse.json({ error: "a non-empty recipients array is required" }, { status: 400 });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json({ error: `payroll batch too large — max ${MAX_RECIPIENTS} recipients per batch` }, { status: 400 });
  }
  if (!isSupportedToken(tokenAddress)) {
    return NextResponse.json({ error: `unsupported payroll token ${tokenAddress} — see supportedTokens.ts` }, { status: 400 });
  }

  // ── EURC SAFETY GATE (Phase 1, retained in Phase 2C) ───────────────────────
  // x402/Gateway settlement is USDC-only. The on-chain payroll contract
  // funding path (fundBatchFor) receives funds swept from an x402 USDC
  // settlement. Passing a non-USDC token would cause fundBatchFor to revert
  // (the relayer holds USDC, not EURC), but we reject early with a clear
  // message rather than letting it hit the contract and produce a confusing
  // revert. EURC payroll on the DIRECT path (/api/payroll/run, wallet
  // transfers) ships in Phase 2C; THIS x402 gateway path stays USDC-only.
  const resolvedToken = token ? getTokenByAddress(tokenAddress) : null;
  if (resolvedToken?.symbol === 'EURC') {
    return NextResponse.json(
      { error: "EURC payroll is not yet supported — x402 settlement is USDC-only. EURC payroll support ships in Phase 2." },
      { status: 400 }
    );
  }

  const totalAmount = recipients.reduce((sum, r) => sum + r.amount, BigInt(0));
  const price = (Number(totalAmount) / 1e6).toFixed(6);

  // 1. 402 challenge when no payment-signature header is present.
  const paymentSignatureHeader = req.headers.get("payment-signature");
  if (!paymentSignatureHeader) {
    return paymentRequiredResponse(ENDPOINT, price);
  }

  // 2. verify — a VIEW call, no funds move. Yields the payer (a forged
  // payer fails verify, so everything after this can trust `payer`).
  let paymentPayload: any;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentSignatureHeader, "base64").toString("utf-8"));
  } catch {
    return NextResponse.json({ error: "Invalid payment signature encoding." }, { status: 402 });
  }

  const verify = await verifyPayment(paymentPayload, price);
  if (!verify.isValid) {
    return NextResponse.json(
      { error: "Payment verification failed", reason: verify.invalidReason },
      { status: 402 }
    );
  }
  const payer = verify.payer!;

  // 3. the merchant calling this must control the wallet that paid.
  const actor = await verifyCallerControlsAddress(req, payer);
  if (!actor) {
    return NextResponse.json(
      { error: "Payer wallet is not controlled by this merchant account." },
      { status: 403 }
    );
  }

  // 4. spend-limit PRE-FLIGHT — before settle, before any funds move.
  const spendCheck = await checkSpendAllowed({ agentAddress: payer, amount: totalAmount });
  if (!spendCheck.allowed) {
    return NextResponse.json(
      { error: `Payroll spend limit rejected: ${spendCheck.reason}. No payment was taken.` },
      { status: 403 }
    );
  }

  // 5. settle — the merchant's funds arrive at the seller's gateway wallet.
  const settle = await settlePayment(paymentPayload, price);
  if (!settle.settled) {
    return NextResponse.json(
      { error: "Payment settlement failed", reason: settle.errorReason },
      { status: 402 }
    );
  }

  // 6. sweep the settled amount to the relayer EOA (settlement lands in the
  // seller's gateway wallet, but fundBatchFor is signed by the relayer).
  // Serialized (H10): concurrent sweeps never race the shared seller
  // balance; the withdraw is exactly `price` and the balance delta is
  // recorded for audit. If the sweep fails the funds are safely held by the
  // seller gateway — flag for review rather than losing the audit trail.
  let sweepTxHash: string | undefined;
  let sweepBalanceBefore: string | undefined;
  let sweepBalanceAfter: string | undefined;
  try {
    const sweep = await sweepSettledToRelayer(price);
    sweepTxHash = sweep.mintTxHash;
    sweepBalanceBefore = sweep.balanceBefore;
    sweepBalanceAfter = sweep.balanceAfter;
  } catch (sweepError: any) {
    const recoveryId = await enqueueForReview({
      agentAddress: payer,
      amount: totalAmount,
      jobCriteriaId: `payroll:${recipients.length}-recipients`,
      gatewayRef: settle.transaction ?? "unknown",
      settlementTxHash: settle.transaction ?? "unknown",
      failureReason: `seller sweep failed after settlement: ${sweepError.message}`,
    });
    return NextResponse.json(
      {
        error: "Payroll funding failed after settlement (seller sweep).",
        detail: `Your payment of ${price} USDC settled but could not be swept to the funding wallet. Funds are held safely by the seller gateway. Review record: ${recoveryId}.`,
        recoveryId,
        gatewayRef: settle.transaction,
      },
      { status: 500 }
    );
  }

  // 7. on-chain enforcement. If a concurrent spend from the same merchant
  // pushed it over cap between pre-flight and here, this reverts and the
  // settled funds are automatically refunded — nothing is held hostage.
  try {
    const spendTx = await getSpendLimitContract().checkAndRecordSpend(payer, totalAmount);
    await spendTx.wait();
  } catch (spendLimitError: any) {
    const { refundTxHash, recoveryId } = await recoverFromSpendLimitRaceFailure({
      agentAddress: payer,
      amount: totalAmount,
      jobCriteriaId: `payroll:${recipients.length}-recipients`,
      gatewayRef: settle.transaction ?? "unknown",
      settlementTxHash: settle.transaction ?? "unknown",
      failureReason: spendLimitError?.message ?? "checkAndRecordSpend reverted",
    });

    return NextResponse.json(
      {
        error: "Payroll funding failed after settlement due to a spend-limit race.",
        detail: `Your payment of ${price} USDC has been automatically refunded (tx: ${refundTxHash}). Recovery record: ${recoveryId}. Retry once your spending window allows it.`,
        refundTxHash,
        recoveryId,
      },
      { status: 409 }
    );
  }

  // 8. backend audit bookkeeping (never gates the response).
  await recordSpend({ agentAddress: payer, amount: totalAmount });

  // 9. fund the batch on-chain. The payroll contract pulls `totalAmount`
  // from the relayer via transferFrom — Arc charges a per-target ERC-20 fee
  // on that move (measured ~0.2% into contracts 2026-08-19; ~0.001028 flat
  // EOA→EOA; never assume a rate). H11: the fee is MEASURED as the real
  // relayer balance delta around the funding tx and recorded in the batch
  // row + response, so the accounting is exact and auditable.
  const payroll = getPayrollContract();
  const addresses = recipients.map((r) => r.address);
  const amounts = recipients.map((r) => r.amount);
  await ensurePayrollAllowance(payer, tokenAddress, amounts);
  const feeProvider = new (await import("ethers")).JsonRpcProvider(process.env.ARC_TESTNET_RPC);
  const usdcView = new (await import("ethers")).Contract(
    getUsdcAddress(),
    ["function balanceOf(address) view returns (uint256)"],
    feeProvider
  );
  const relayerAddress = await getRelayerSigner().getAddress();
  const relayerBefore = BigInt(await usdcView.balanceOf(relayerAddress));
  let fundTx;
  try {
    fundTx = await payroll.fundBatchFor(payer, tokenAddress, addresses, amounts);
  } catch (fundError: any) {
    const { refundTxHash, recoveryId } = await recoverFromSpendLimitRaceFailure({
      agentAddress: payer,
      amount: totalAmount,
      jobCriteriaId: `payroll:${recipients.length}-recipients`,
      gatewayRef: settle.transaction ?? "unknown",
      settlementTxHash: settle.transaction ?? "unknown",
      failureReason: `fundBatchFor failed after spend record: ${fundError?.message ?? "revert"}`,
    });
    return NextResponse.json(
      {
        error: "Payroll funding failed after settlement (batch funding).",
        detail: `Your payment of ${price} USDC has been automatically refunded (tx: ${refundTxHash}). Recovery record: ${recoveryId}. Retry the request.`,
        refundTxHash,
        recoveryId,
      },
      { status: 500 }
    );
  }
  const fundReceipt = await fundTx.wait();
  const batchId = parseEventValue(fundReceipt, PAYROLL_ABI, "BatchFunded", "batchId");

  // Measured fee: relayer debit minus the exact batch total. Positive =
  // the ERC-20 interface fee on the transferFrom; recorded, never assumed.
  const relayerAfter = BigInt(await usdcView.balanceOf(relayerAddress, { blockTag: fundReceipt.blockNumber }));
  const actualDebit = relayerBefore - relayerAfter;
  const feeMeasured = actualDebit > totalAmount ? actualDebit - totalAmount : 0n;
  console.log(
    `[payroll/fund] batch ${batchId}: total ${Number(totalAmount) / 1e6} USDC, relayer debit ${Number(actualDebit) / 1e6} USDC, measured fee ${Number(feeMeasured) / 1e6} USDC`
  );

  // DB bookkeeping (never gates the response).
  // Phase 2C: this x402/Gateway funding path is genuinely USDC-only (the
  // EURC gate above rejects anything else), so both rows persist the
  // explicit USDC identity — currency AND canonical tokenAddress — rather
  // than relying on the NULL-means-USDC legacy convention.
  const batchRef = `payroll-x402-${batchId}`;
  const usdcAddress = getUsdcAddress();
  prisma.payrollBatch.create({
    data: {
      batchRef,
      payerSCA: payer,
      payerWalletId: null,
      totalAmount: Number(totalAmount) / 1e6,
      currency: "USDC",
      tokenAddress: usdcAddress,
      recipientCount: addresses.length,
      successCount: addresses.length,
      failedCount: 0,
      status: "FUNDED",
      results: {
        batchId: batchId.toString(),
        fundTxHash: fundReceipt.hash,
        sweepTxHash,
        sweepBalanceBefore,
        sweepBalanceAfter,
        feeMeasured: feeMeasured.toString(), // 6-dec units, measured on-chain
        relayerDebit: actualDebit.toString(),
        currency: "USDC",
        tokenAddress: usdcAddress,
      },
    },
  }).catch((e: any) => console.error("[payroll/fund] batch row failed:", e.message));

  prisma.paymentLog.create({
    data: {
      reference: `payroll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      amount: Number(totalAmount) / 1e6,
      currency: "USDC",
      tokenAddress: usdcAddress,
      chain: "Arc Testnet x402",
      senderEmail: payer,
      merchant: ENDPOINT,
      status: "SUCCESS",
      arcTxHash: fundReceipt.hash,
      gatewayReference: settle.transaction ?? null,
    },
  }).catch((e: any) => console.error("[payroll/fund] payment log failed:", e.message));

  const response = NextResponse.json({
    success: true,
    batchId: batchId.toString(),
    txHash: fundReceipt.hash,
    sweepTxHash,
    gatewayRef: settle.transaction,
    recipientCount: addresses.length,
    feeMeasured: Number(feeMeasured) / 1e6,
    message: `Payroll batch ${batchId} funded (${addresses.length} recipients, ${price} USDC, measured ERC-20 fee ${Number(feeMeasured) / 1e6} USDC).`,
  });
  response.headers.set(
    "PAYMENT-RESPONSE",
    Buffer.from(
      JSON.stringify({
        success: true,
        transaction: fundReceipt.hash,
        network: "eip155:5042002",
        payer,
      })
    ).toString("base64")
  );
  return response;
}

/** Executes an already-funded batch (relayer-signed). */
export async function executePayrollBatch(batchId: string): Promise<{ txHash: string }> {
  const payroll = getPayrollContract();
  const tx = await payroll.executeBatch(batchId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** Cancels a Funded batch, refunding the merchant (relayer-signed). */
export async function cancelPayrollBatch(batchId: string): Promise<{ txHash: string }> {
  const payroll = getPayrollContract();
  const tx = await payroll.cancelBatch(batchId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}