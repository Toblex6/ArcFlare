// src/app/api/checkout/[reference]/bridge/complete/route.ts
//
// Proves the Arc mint for a checkout cross-chain intent and only THEN marks the
// invoice paid. The burn↔mint binding nonce comes from Circle Iris (resolved by
// the bound burn hash), and the mint must credit this invoice's merchant wallet.
//
// Credit rule: the invoice is paid only when the measured Arc credit is >= the
// invoice amount. The intent's burn was grossed up server-side for the relay
// fee, so a merchant is never underpaid. If the mint has not landed yet this is
// a retryable MINT_NOT_READY response — recovery reuses the same burn and never
// asks for a second one.

import { NextRequest, NextResponse } from "next/server";
import { pad } from "viem";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { explorerTxUrl } from "@/lib/config/network";
import { formatBridgeBaseUnits } from "@/lib/bridge/sourceChains";
import { verifyArcMint, sourceCctpV2 } from "@/lib/bridge/externalVerify";
import { fetchIrisBridgeMessage } from "@/lib/bridge/irisNonce";
import { logBridgeStage } from "@/lib/bridge/stageLogger";
import { invoiceAmountBaseUnits, creditSatisfiesInvoice } from "@/lib/checkout/bridgeGross";
import { settleFeeBestEffort } from "@/lib/payments/settleFeeBestEffort";
import { resolveRowCurrency } from "@/lib/tokens/resolveCurrency";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, "payments");
    if (!allowed) return limitResponse!;

    const { reference } = await params;
    const body = await req.json().catch(() => ({}));
    const intentId = typeof body?.intent === "string" ? body.intent : "";
    const suppliedMint = typeof body?.mintTxHash === "string" ? body.mintTxHash : "";
    if (!intentId) {
      return NextResponse.json({ success: false, code: "INTENT_REQUIRED", error: "Missing cross-chain payment intent." }, { status: 400 });
    }

    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.invoiceReference !== reference) {
      return NextResponse.json({ success: false, code: "INTENT_NOT_FOUND", error: "No cross-chain payment found for this invoice." }, { status: 404 });
    }
    const invoice = await (prisma as any).paymentLog.findUnique({ where: { reference } });
    if (!invoice) {
      return NextResponse.json({ success: false, code: "INVOICE_NOT_FOUND", error: "Invoice not found." }, { status: 404 });
    }

    if (intent.status === "COMPLETED") {
      const actual = intent.actualAmount ? BigInt(intent.actualAmount) : 0n;
      return NextResponse.json({
        success: true,
        state: "completed",
        reference: intent.id,
        actualAmount: intent.actualAmount ?? null,
        actualAmountDisplay: intent.actualAmount ? formatBridgeBaseUnits(actual) : null,
        mintTxHash: intent.mintTxHash ?? null,
        destinationExplorerUrl: intent.mintTxHash ? explorerTxUrl(intent.mintTxHash) : null,
      });
    }
    if (intent.status === "FAILED") {
      return NextResponse.json({ success: false, code: "INTENT_FAILED", error: intent.error ?? "This payment failed and cannot be resumed." }, { status: 400 });
    }
    if (intent.status !== "BURN_CONFIRMED") {
      return NextResponse.json({ success: false, code: "COMPLETE_REQUIRES_BURN", error: "Verify the source burn first." }, { status: 400 });
    }

    const cctp = sourceCctpV2(intent.sourceChain);
    if (!cctp || !intent.burnTxHash) {
      return NextResponse.json({ success: false, code: "INTENT_STATE_CONFLICT", error: "This payment is missing its verified burn." }, { status: 409 });
    }

    const iris = await fetchIrisBridgeMessage({ sourceDomain: cctp.domain, burnTxHash: intent.burnTxHash });
    if (!iris.ok) {
      if (["NOT_FOUND", "ATTESTATION_PENDING", "IRIS_UNAVAILABLE"].includes(iris.reason)) {
        return NextResponse.json(
          {
            success: false,
            code: "MINT_NOT_READY",
            reason: iris.reason,
            error: "Circle is still attesting this transfer. Your USDC is on the way — keep checking; do not start another transfer.",
          },
          { status: 422 }
        );
      }
      return NextResponse.json({ success: false, code: "MINT_NOT_VERIFIED", reason: "NONCE_MISMATCH", error: "This burn cannot be matched to an Arc mint." }, { status: 422 });
    }

    const mintTxHash = (iris.destinationMintTxHash ?? iris.forwardTxHash ?? suppliedMint) as string | null;
    if (!mintTxHash || !/^0x[0-9a-fA-F]{64}$/.test(mintTxHash)) {
      return NextResponse.json(
        { success: false, code: "MINT_NOT_READY", reason: "MINT_PENDING", error: "Circle has not relayed the Arc mint yet. Keep checking this same payment; do not start another transfer." },
        { status: 422 }
      );
    }
    if (suppliedMint && (iris.destinationMintTxHash ?? iris.forwardTxHash) &&
        suppliedMint.toLowerCase() !== (iris.destinationMintTxHash ?? iris.forwardTxHash)!.toLowerCase()) {
      return NextResponse.json({ success: false, code: "MINT_NOT_VERIFIED", reason: "NONCE_MISMATCH", error: "That transaction is not the Arc mint for this payment." }, { status: 422 });
    }

    await logBridgeStage(intent.id, {
      stage: "MINT_PENDING",
      txHash: mintTxHash,
      chainId: cctp.domain,
      metadata: { invoiceReference: reference, destination: intent.destination },
    });

    const proof = await verifyArcMint({
      destination: intent.destination,
      mintTxHash,
      expectedNonce: iris.nonce,
      expectedAmount: BigInt(intent.amount),
      expectedSourceDomain: cctp.domain,
      expectedSender: pad(cctp.tokenMessenger as `0x${string}`, { size: 32 }),
    });
    if (!proof.ok) {
      await logBridgeStage(intent.id, {
        stage: "FAILED",
        txHash: mintTxHash,
        errorDetail: proof.detail ?? proof.reason,
        metadata: { reason: proof.reason, invoiceReference: reference, ...(proof.actualAmount !== undefined ? { actualAmount: proof.actualAmount.toString() } : {}) },
      });
      return NextResponse.json(
        { success: false, code: "MINT_NOT_VERIFIED", reason: proof.reason, error: "The Arc mint does not match this payment. Keep this payment reference — do not start another transfer." },
        { status: 422 }
      );
    }

    const actual = proof.actualAmount;
    const invoiceUnits = invoiceAmountBaseUnits(Number(invoice.amount));
    if (!creditSatisfiesInvoice(actual, invoiceUnits)) {
      // The mint is real, but the merchant was credited less than the invoice.
      // Do NOT mark paid. Record the measured credit so the owner can resolve
      // the shortfall; the same burn is never repeated.
      await (prisma as any).flowBridgeIntent.updateMany({
        where: { id: intent.id, status: "BURN_CONFIRMED" },
        data: { status: "COMPLETED", mintTxHash: proof.mintTxHash, actualAmount: actual.toString(), cctpNonce: iris.nonce },
      });
      return NextResponse.json(
        {
          success: false,
          code: "UNDERPAID",
          reason: "CREDIT_BELOW_INVOICE",
          actualAmount: actual.toString(),
          invoiceAmount: invoiceUnits.toString(),
          error: "The Arc credit was below the invoice amount, so the invoice was not marked paid. No second transfer is needed; contact support with this reference.",
        },
        { status: 409 }
      );
    }

    const nowIso = new Date();
    const marked = await (prisma as any).$transaction(async (tx: any) => {
      const claim = await tx.flowBridgeIntent.updateMany({
        where: { id: intent.id, status: "BURN_CONFIRMED" },
        data: { status: "COMPLETED", mintTxHash: proof.mintTxHash, actualAmount: actual.toString(), cctpNonce: iris.nonce },
      });
      if (claim.count === 0) {
        const reread = await tx.flowBridgeIntent.findUnique({ where: { id: intent.id } });
        return { paid: false, state: reread?.status ?? "UNKNOWN" };
      }
      const updated = await tx.paymentLog.updateMany({
        where: { reference, status: { in: ["PENDING", "PROCESSING_ONCHAIN"] } },
        data: {
          status: "SUCCESS",
          arcTxHash: proof.mintTxHash,
          payerSCA: intent.sourceWallet,
          senderEmail: intent.sourceWallet,
          chain: "Arc (CCTP Bridge)",
        },
      });
      return { paid: updated.count === 1, state: "COMPLETED" };
    });

    await logBridgeStage(intent.id, {
      stage: "MINT_CONFIRMED",
      txHash: proof.mintTxHash,
      metadata: { invoiceReference: reference, actualAmount: actual.toString(), invoiceAmount: invoiceUnits.toString(), paid: marked.paid },
    });

    if (!marked.paid) {
      const rereadInvoice = await (prisma as any).paymentLog.findUnique({ where: { reference } });
      if (rereadInvoice?.status === "SUCCESS") {
        return NextResponse.json({
          success: true,
          state: "completed",
          reference: intent.id,
          actualAmount: actual.toString(),
          actualAmountDisplay: formatBridgeBaseUnits(actual),
          mintTxHash: proof.mintTxHash,
          destinationExplorerUrl: explorerTxUrl(proof.mintTxHash),
        });
      }
      return NextResponse.json({ success: false, code: "INTENT_STATE_CONFLICT", error: "The payment changed state while completing. Retry status." }, { status: 409 });
    }

    // Preserve the existing 25 bps checkout fee flow. This runs only after
    // verified merchant mint credit and never rolls back the paid invoice.
    const settledInvoice = await (prisma as any).paymentLog.findUnique({ where: { reference } });
    if (settledInvoice) {
      try {
        const token = resolveRowCurrency(settledInvoice);
        await settleFeeBestEffort(settledInvoice, token);
      } catch (e: any) {
        console.error('[checkout/bridge] platform fee deferred:', e?.message ?? e);
      }
    }

    return NextResponse.json({
      success: true,
      state: "completed",
      reference: intent.id,
      actualAmount: actual.toString(),
      actualAmountDisplay: formatBridgeBaseUnits(actual),
      invoiceAmount: invoiceUnits.toString(),
      mintTxHash: proof.mintTxHash,
      destinationExplorerUrl: explorerTxUrl(proof.mintTxHash),
      settledAt: nowIso.toISOString(),
    });
  } catch (error: any) {
    console.error("[checkout/bridge/complete]", error);
    return NextResponse.json({ success: false, error: "Could not complete the cross-chain payment yet." }, { status: 500 });
  }
}
