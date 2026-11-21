// src/app/api/checkout/[reference]/bridge/complete/route.ts
//
// Proves the Arc mint for a checkout cross-chain intent and only THEN marks the
// invoice paid. The burn↔mint binding nonce comes from Circle Iris (resolved by
// the bound burn hash), and the mint must credit this invoice's merchant wallet.
//
// Count each verified Arc credit once. An underpaid invoice stays unpaid and
// may receive another invoice-bound leg after the prior mint is confirmed.

import { NextRequest, NextResponse } from "next/server";
import { pad } from "viem";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { explorerTxUrl, getNetworkConfig } from "@/lib/config/network";
import { formatBridgeBaseUnits } from "@/lib/bridge/sourceChains";
import { verifyArcMint, sourceCctpV2 } from "@/lib/bridge/externalVerify";
import { fetchIrisBridgeMessage } from "@/lib/bridge/irisNonce";
import { logBridgeStage } from "@/lib/bridge/stageLogger";
import { checkoutShortfall, invoiceAmountBaseUnits } from "@/lib/checkout/bridgeGross";
import { checkoutBridgeBelongsTo, lockCheckoutBridge, readCheckoutBridgeCredit } from "@/lib/checkout/bridgeCredits";
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
    if (!intent || !checkoutBridgeBelongsTo(intent, reference)) {
      return NextResponse.json({ success: false, code: "INTENT_NOT_FOUND", error: "No cross-chain payment found for this invoice." }, { status: 404 });
    }
    const invoice = await (prisma as any).paymentLog.findUnique({ where: { reference } });
    if (!invoice) {
      return NextResponse.json({ success: false, code: "INVOICE_NOT_FOUND", error: "Invoice not found." }, { status: 404 });
    }

    const invoiceUnits = invoiceAmountBaseUnits(Number(invoice.amount));
    const respond = (paid: boolean, credited: bigint, mintTxHash: string | null) => {
      const remaining = checkoutShortfall(invoiceUnits, credited);
      if (!paid && remaining === 0n) {
        return NextResponse.json({ success: false, code: "INTENT_STATE_CONFLICT", error: "The verified credit needs invoice review." }, { status: 409 });
      }
      return NextResponse.json({
        success: paid,
        state: paid ? "completed" : "underpaid",
        ...(paid ? {} : { code: "UNDERPAID", error: "The merchant received a partial payment. Top up the remaining balance to complete the invoice." }),
        reference: intent.id,
        actualAmount: credited.toString(),
        actualAmountDisplay: formatBridgeBaseUnits(credited),
        invoiceAmount: invoiceUnits.toString(),
        remainingAmountDisplay: formatBridgeBaseUnits(remaining),
        mintTxHash,
        destinationExplorerUrl: mintTxHash ? explorerTxUrl(mintTxHash) : null,
      }, { status: paid ? 200 : 409 });
    };
    if (intent.status === "COMPLETED") {
      return respond(invoice.status === "SUCCESS", await readCheckoutBridgeCredit(prisma, reference), intent.mintTxHash);
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
      chainId: getNetworkConfig().chainId,
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
    const marked = await (prisma as any).$transaction(async (tx: any) => {
      await lockCheckoutBridge(tx, reference);
      const existing = await tx.flowBridgeIntent.findFirst({
        where: { id: { not: intent.id }, mintTxHash: { equals: proof.mintTxHash, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) return null;
      const claim = await tx.flowBridgeIntent.updateMany({
        where: { id: intent.id, status: "BURN_CONFIRMED" },
        data: { status: "COMPLETED", mintTxHash: proof.mintTxHash, actualAmount: actual.toString(), cctpNonce: iris.nonce },
      });
      const credited = await readCheckoutBridgeCredit(tx, reference);
      const updated = claim.count === 1 && checkoutShortfall(invoiceUnits, credited) === 0n
        ? await tx.paymentLog.updateMany({
        where: { reference, status: { in: ["PENDING", "PROCESSING_ONCHAIN", "EXPIRED"] } },
        data: {
          status: "SUCCESS",
          arcTxHash: proof.mintTxHash,
          payerSCA: intent.sourceWallet,
          senderEmail: intent.sourceWallet,
          chain: "Arc (CCTP Bridge)",
        },
      }) : { count: 0 };
      const current = await tx.paymentLog.findUnique({ where: { reference }, select: { status: true } });
      return { newlyPaid: updated.count === 1, paid: current?.status === "SUCCESS", credited, newMint: claim.count === 1 };
    });
    if (!marked) return NextResponse.json({ success: false, code: "INTENT_ALREADY_USED", error: "This mint evidence is already attached to a payment." }, { status: 409 });

    if (marked.newMint) await logBridgeStage(intent.id, {
      stage: "MINT_CONFIRMED",
      txHash: proof.mintTxHash,
      chainId: getNetworkConfig().chainId,
      metadata: { invoiceReference: reference, actualAmount: actual.toString(), invoiceAmount: invoiceUnits.toString(), paid: marked.paid },
    });

    // Preserve the existing 25 bps checkout fee flow. This runs only after
    // verified merchant mint credit and never rolls back the paid invoice.
    const settledInvoice = marked.newlyPaid ? await (prisma as any).paymentLog.findUnique({ where: { reference } }) : null;
    if (settledInvoice) {
      try {
        const token = resolveRowCurrency(settledInvoice);
        await settleFeeBestEffort(settledInvoice, token);
      } catch (e: any) {
        console.error('[checkout/bridge] platform fee deferred:', e?.message ?? e);
      }
    }

    return respond(marked.paid, marked.credited, proof.mintTxHash);
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ success: false, code: "INTENT_ALREADY_USED", error: "This mint evidence is already attached to a payment." }, { status: 409 });
    }
    console.error("[checkout/bridge/complete]", error);
    return NextResponse.json({ success: false, error: "Could not complete the cross-chain payment yet." }, { status: 500 });
  }
}
