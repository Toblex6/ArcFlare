// src/app/api/checkout/[reference]/bridge/confirm/route.ts
//
// Proves the source-chain burn for a checkout cross-chain intent, reusing the
// same fail-closed verifier as the consumer external bridge: mined receipt,
// tx.from == the intent's payer wallet, exact canonical-USDC debit for the
// gross amount, and a decodable CCTP V2 deposit naming this invoice's merchant
// address as mint recipient. A client "success" boolean is never accepted.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { findBridgeSourceChain, sourceExplorerTxUrl } from "@/lib/bridge/sourceChains";
import { verifyExternalBurn } from "@/lib/bridge/externalVerify";
import { logBridgeStage } from "@/lib/bridge/stageLogger";
import { checkoutBridgeBelongsTo, lockCheckoutBridge } from "@/lib/checkout/bridgeCredits";

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
    const burnTxHash = typeof body?.burnTxHash === "string" ? body.burnTxHash : "";
    if (!intentId) {
      return NextResponse.json({ success: false, code: "INTENT_REQUIRED", error: "Missing cross-chain payment intent." }, { status: 400 });
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
      return NextResponse.json({ success: false, code: "BURN_HASH_INVALID", error: "Missing or invalid source burn transaction." }, { status: 400 });
    }

    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intentId } });
    if (!intent || !checkoutBridgeBelongsTo(intent, reference)) {
      return NextResponse.json({ success: false, code: "INTENT_NOT_FOUND", error: "No cross-chain payment found for this invoice." }, { status: 404 });
    }
    const found = findBridgeSourceChain(intent.sourceChain);
    const source = found?.chain ?? null;
    const sourceNet = found?.network ?? "testnet";

    if (intent.status === "COMPLETED" && intent.burnTxHash?.toLowerCase() === burnTxHash.toLowerCase()) {
      return NextResponse.json({
        success: true,
        state: "completed",
        reference: intent.id,
        mintTxHash: intent.mintTxHash ?? null,
      });
    }
    if (intent.status === "FAILED") {
      return NextResponse.json({ success: false, code: "INTENT_FAILED", error: intent.error ?? "This payment failed and cannot be resumed." }, { status: 400 });
    }
    if (intent.status === "BURN_CONFIRMED" || intent.status === "COMPLETED") {
      if ((intent.burnTxHash ?? "").toLowerCase() === burnTxHash.toLowerCase()) {
        return NextResponse.json({
          success: true,
          state: "burn-confirmed",
          reference: intent.id,
          sourceExplorerUrl: source ? sourceExplorerTxUrl(source.id, intent.burnTxHash, sourceNet) : null,
        });
      }
      return NextResponse.json({ success: false, code: "INTENT_ALREADY_USED", error: "This payment already has a verified burn. One burn settles one invoice — do not burn again." }, { status: 409 });
    }

    // The invoice must still be payable when the burn is presented.
    const invoice = await (prisma as any).paymentLog.findUnique({ where: { reference } });
    if (!invoice) {
      return NextResponse.json({ success: false, code: "INVOICE_NOT_FOUND", error: "Invoice not found." }, { status: 404 });
    }
    if (invoice.status === "SUCCESS") {
      return NextResponse.json({ success: false, code: "INVOICE_PAID", error: "This invoice is already paid." }, { status: 409 });
    }

    await logBridgeStage(intent.id, {
      stage: "BURN_PENDING",
      txHash: burnTxHash,
      chainId: source?.chainId,
      metadata: { invoiceReference: reference, sourceChain: intent.sourceChain, sourceWallet: intent.sourceWallet },
    });

    const proof = await verifyExternalBurn({
      sourceId: intent.sourceChain,
      sourceAddress: intent.sourceWallet,
      amountBaseUnits: BigInt(intent.amount),
      destination: intent.destination,
      burnTxHash,
    });
    if (!proof.ok) {
      await logBridgeStage(intent.id, {
        stage: "FAILED",
        txHash: burnTxHash,
        chainId: source?.chainId,
        errorDetail: proof.detail ?? proof.reason,
        metadata: { reason: proof.reason, candidateOnly: true, recoverable: true },
      });
      return NextResponse.json(
        {
          success: false,
          code: "BURN_NOT_VERIFIED",
          reason: proof.reason,
          recoverable: true,
          error: "That transaction does not prove this payment's burn. Check your wallet activity; if a burn exists, recover this same payment instead of starting another.",
        },
        { status: 422 }
      );
    }

    const claim = await (prisma as any).$transaction(async (tx: any) => {
      await lockCheckoutBridge(tx, reference);
      const currentInvoice = await tx.paymentLog.findUnique({ where: { reference }, select: { status: true } });
      if (!["PENDING", "PROCESSING_ONCHAIN", "EXPIRED"].includes(currentInvoice?.status)) return { count: 0 };
      const existing = await tx.flowBridgeIntent.findFirst({
        where: { id: { not: intent.id }, burnTxHash: { equals: proof.burnTxHash, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) return { count: 0 };
      return tx.flowBridgeIntent.updateMany({
        where: { id: intent.id, status: "PENDING" },
        data: {
          status: "BURN_CONFIRMED",
          burnTxHash: proof.burnTxHash,
          destinationBound: proof.destinationBound,
          cctpNonce: proof.cctpNonce,
        },
      });
    });
    if (claim.count === 0) {
      const reread = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intent.id } });
      if (["BURN_CONFIRMED", "COMPLETED"].includes(reread?.status) && (reread.burnTxHash ?? "").toLowerCase() === proof.burnTxHash.toLowerCase()) {
        return NextResponse.json({ success: true, state: "burn-confirmed", reference: reread.id });
      }
      return NextResponse.json({ success: false, code: "INTENT_STATE_CONFLICT", error: "This payment changed state while confirming. Retry status." }, { status: 409 });
    }

    await logBridgeStage(intent.id, {
      stage: "BURN_CONFIRMED",
      txHash: proof.burnTxHash,
      chainId: source?.chainId,
      metadata: { invoiceReference: reference, destinationBound: proof.destinationBound, cctpNonce: proof.cctpNonce },
    });

    return NextResponse.json({
      success: true,
      state: "burn-confirmed",
      reference: intent.id,
      destinationBound: proof.destinationBound,
      sourceExplorerUrl: source ? sourceExplorerTxUrl(source.id, proof.burnTxHash, sourceNet) : null,
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ success: false, code: "INTENT_ALREADY_USED", error: "This burn evidence is already attached to a payment." }, { status: 409 });
    }
    console.error("[checkout/bridge/confirm]", error);
    return NextResponse.json({ success: false, error: "Could not verify the cross-chain payment yet." }, { status: 500 });
  }
}
