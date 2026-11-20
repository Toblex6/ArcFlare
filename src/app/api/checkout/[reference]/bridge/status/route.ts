// src/app/api/checkout/[reference]/bridge/status/route.ts
//
// Read-only checkout bridge status. Recovery (after a reload or an interrupted
// wallet prompt) reads this and resumes the SAME intent — verification and
// completion re-prove everything on-chain, so this route is never an authority.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { formatBridgeBaseUnits } from "@/lib/bridge/sourceChains";
import { explorerTxUrl } from "@/lib/config/network";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { reference } = await params;
    const intentId = new URL(req.url).searchParams.get("intent") ?? "";
    if (!intentId) {
      return NextResponse.json({ success: false, code: "INTENT_REQUIRED", error: "Missing intent." }, { status: 400 });
    }
    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.invoiceReference !== reference) {
      return NextResponse.json({ success: false, code: "INTENT_NOT_FOUND", error: "No cross-chain payment found for this invoice." }, { status: 404 });
    }
    const invoice = await (prisma as any).paymentLog.findUnique({
      where: { reference },
      select: { status: true, arcTxHash: true },
    });
    return NextResponse.json({
      success: true,
      reference: intent.id,
      state: intent.status,
      burnTxHash: intent.burnTxHash ?? null,
      mintTxHash: intent.mintTxHash ?? null,
      amount: intent.amount,
      amountDisplay: formatBridgeBaseUnits(BigInt(intent.amount)),
      actualAmount: intent.actualAmount ?? null,
      actualAmountDisplay: intent.actualAmount ? formatBridgeBaseUnits(BigInt(intent.actualAmount)) : null,
      destinationExplorerUrl: intent.mintTxHash ? explorerTxUrl(intent.mintTxHash) : null,
      invoiceStatus: invoice?.status ?? null,
      invoicePaid: invoice?.status === "SUCCESS",
    });
  } catch (error: any) {
    console.error("[checkout/bridge/status]", error);
    return NextResponse.json({ success: false, error: "Could not read the cross-chain payment." }, { status: 500 });
  }
}
