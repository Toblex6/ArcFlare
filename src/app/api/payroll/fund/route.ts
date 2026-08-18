// src/app/api/payroll/fund/route.ts
//
// Gasless payroll batch funding for ArcFlarePayroll.sol via x402.
//
// Order of operations (this ordering is the point):
//   1. 402 challenge when no payment-signature header is present.
//   2. verify(payload) — a VIEW call, no funds move. Yields the payer.
//   3. Caller-control check (merchant must control the payer wallet).
//   4. Spend-limit PRE-FLIGHT (wouldExceedLimit) — an over-cap merchant gets
//      a clean 403 BEFORE its money leaves its wallet, not pay-then-fail.
//   5. settle(payload) — funds move to the relayer.
//   6. checkAndRecordSpend(payer, total) — the on-chain enforcement. If a
//      concurrent spend pushed the merchant over cap in the race window,
//      this reverts and the settled funds are auto-refunded (settlement
//      recovery), surfaced as a 409 with the refund tx hash.
//   7. fundBatchFor(merchant = payer, ...) via the relayer, then respond.
//
// Because of the interleaving between steps 2-5 (spend-limit check must run
// between verify and settle), this route cannot use the withGateway()
// middleware wholesale — it uses the shared paymentRequiredResponse /
// verifyPayment / settlePayment primitives from src/lib/x402.ts so the
// challenge format stays identical.

import { NextRequest, NextResponse } from 'next/server';
import { Contract, parseUnits } from 'ethers';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { paymentRequiredResponse, verifyPayment, settlePayment } from '@/lib/x402';
import { checkSpendAllowed, getSpendLimitContract } from '@/lib/agents/spendLimitEnforcer';
import { recoverFromSpendLimitRaceFailure } from '@/lib/jobs/settlementRecovery';
import { getUsdcAddress } from '@/lib/tokens/supportedTokens';
import { getRelayerSigner } from '@/lib/wallet/jobEscrowClient';
import { parseEventValue } from '@/lib/contracts/receiptParser';

const PAYROLL_CONTRACT_ADDRESS = process.env.PAYROLL_CONTRACT_ADDRESS ?? "";

const PAYROLL_ABI = [
  "function fundBatchFor(address merchant, address token, address[] recipients, uint256[] amounts) external returns (uint256 batchId)",
  "function executeBatch(uint256 batchId) external",
  "event BatchFunded(uint256 indexed batchId, address indexed merchant, address token, uint256 totalFunded, uint32 recipientCount)",
];

const ENDPOINT = "/api/payroll/fund";
const MAX_RECIPIENTS = 200; // mirrors the on-chain cap in ArcFlarePayroll._createBatch

interface PayrollRecipient {
  address: string;
  amount: string | number;
}

function getPayrollContract(): Contract {
  if (!PAYROLL_CONTRACT_ADDRESS) {
    throw new Error("PAYROLL_CONTRACT_ADDRESS is not configured — deploy ArcFlarePayroll.sol first");
  }
  return new Contract(PAYROLL_CONTRACT_ADDRESS, PAYROLL_ABI, getRelayerSigner());
}

function parseRecipients(raw: unknown): { addresses: string[]; amounts: bigint[]; totalAmount: bigint } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("a non-empty recipients array is required");
  }
  if (raw.length > MAX_RECIPIENTS) {
    throw new Error(`payroll batch too large — max ${MAX_RECIPIENTS} recipients per batch`);
  }

  const addresses: string[] = [];
  const amounts: bigint[] = [];
  let totalAmount = 0n;

  for (const r of raw as PayrollRecipient[]) {
    if (!r || typeof r.address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      throw new Error("each recipient needs a valid address");
    }
    const amount = typeof r.amount === "string" || typeof r.amount === "number" ? String(r.amount) : "";
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseFloat(amount) <= 0) {
      throw new Error(`invalid recipient amount: ${r.amount} — use a decimal USDC amount like "0.01"`);
    }
    const amountBig = parseUnits(amount, 6);
    addresses.push(r.address);
    amounts.push(amountBig);
    totalAmount += amountBig;
  }

  return { addresses, amounts, totalAmount };
}

async function fundPayrollHandler(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    let parsed: { addresses: string[]; amounts: bigint[]; totalAmount: bigint };
    try {
      parsed = parseRecipients(body.recipients);
    } catch (validationError: any) {
      return NextResponse.json({ error: validationError.message }, { status: 400 });
    }
    const { addresses, amounts, totalAmount } = parsed;
    const price = (Number(totalAmount) / 1e6).toFixed(6);

    const paymentSignatureHeader = req.headers.get("payment-signature");
    if (!paymentSignatureHeader) {
      return paymentRequiredResponse(ENDPOINT, price);
    }

    let paymentPayload: any;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentSignatureHeader, "base64").toString("utf-8"));
    } catch {
      return NextResponse.json({ error: "Invalid payment signature encoding." }, { status: 402 });
    }

    // 2. verify — view call, nothing has moved yet. This is where the payer
    // is established (a forged payer fails verify, so everything after this
    // can trust `payer`).
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

    // 5. settle — the merchant's funds arrive at the relayer.
    const settle = await settlePayment(paymentPayload, price);
    if (!settle.settled) {
      return NextResponse.json(
        { error: "Payment settlement failed", reason: settle.errorReason },
        { status: 402 }
      );
    }

    // 6. on-chain enforcement. If a concurrent spend from the same merchant
    // pushed it over cap between pre-flight and here, this reverts and the
    // settled funds are automatically refunded — nothing is held hostage.
    try {
      const spendTx = await getSpendLimitContract().checkAndRecordSpend(payer, totalAmount);
      await spendTx.wait();
    } catch (spendLimitError: any) {
      const { refundTxHash, recoveryId } = await recoverFromSpendLimitRaceFailure({
        agentAddress: payer,
        amount: totalAmount,
        jobCriteriaId: `payroll:${addresses.length}-recipients`,
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

    // 7. fund the batch on-chain.
    const payroll = getPayrollContract();
    const fundTx = await payroll.fundBatchFor(payer, getUsdcAddress(), addresses, amounts);
    const fundReceipt = await fundTx.wait();
    const batchId = parseEventValue(fundReceipt, PAYROLL_ABI, "BatchFunded", "batchId");

    // DB bookkeeping (never gates the response).
    const batchRef = `payroll-x402-${batchId}`;
    prisma.payrollBatch.create({
      data: {
        batchRef,
        payerSCA: payer,
        payerWalletId: null,
        totalAmount: Number(totalAmount) / 1e6,
        recipientCount: addresses.length,
        successCount: addresses.length,
        failedCount: 0,
        status: "FUNDED",
        results: { batchId: batchId.toString(), fundTxHash: fundReceipt.hash },
      },
    }).catch((e: any) => console.error("[payroll/fund] batch row failed:", e.message));

    prisma.paymentLog.create({
      data: {
        reference: `payroll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        amount: Number(totalAmount) / 1e6,
        currency: "USDC",
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
      gatewayRef: settle.transaction,
      recipientCount: addresses.length,
      message: `Payroll batch ${batchId} funded (${addresses.length} recipients, ${price} USDC).`,
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
  } catch (error: any) {
    console.error("[payroll/fund] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(fundPayrollHandler);
