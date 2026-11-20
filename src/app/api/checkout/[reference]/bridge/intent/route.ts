// src/app/api/checkout/[reference]/bridge/intent/route.ts
//
// Checkout cross-chain intent. Each payment leg has one durable
// FlowBridgeIntent row. The payer's wallet signs the
// source-chain burn via Circle Bridge Kit in the browser; this server route
// never signs or broadcasts. The mint recipient is ALWAYS the invoice's
// merchant address, resolved from the frozen PaymentLog row — never the body.
//
// Quote the remaining invoice amount with Bridge Kit before creating a leg.

import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { getArcNetworkName } from "@/lib/config/network";
import { resolveRowCurrency } from "@/lib/tokens/resolveCurrency";
import { getBridgeSourceChain, formatBridgeBaseUnits } from "@/lib/bridge/sourceChains";
import { logBridgeStage } from "@/lib/bridge/stageLogger";
import { checkoutShortfall, invoiceAmountBaseUnits } from "@/lib/checkout/bridgeGross";
import { checkoutBridgeScope, lockCheckoutBridge, readCheckoutBridgeCredit } from "@/lib/checkout/bridgeCredits";
import { quoteCheckoutBridge } from "@/lib/checkout/bridgeQuote";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, "payments");
    if (!allowed) return limitResponse!;

    const { reference } = await params;
    const body = await req.json().catch(() => ({}));
    const payerAddress = typeof body?.payerAddress === "string" ? body.payerAddress : "";
    const sourceChain = typeof body?.sourceChain === "string" ? body.sourceChain : "";
    const topUpAfter = typeof body?.topUpAfter === "string" ? body.topUpAfter : null;

    if (!isAddress(payerAddress)) {
      return NextResponse.json({ success: false, code: "PAYER_INVALID", error: "Connect the wallet that will pay." }, { status: 400 });
    }
    const network = getArcNetworkName() === "mainnet" ? "mainnet" : "testnet";
    const source = getBridgeSourceChain(sourceChain, network);
    if (!source) {
      return NextResponse.json(
        { success: false, code: "UNSUPPORTED_SOURCE", error: "This source chain is not supported for paying an invoice." },
        { status: 400 }
      );
    }

    const invoice = await (prisma as any).paymentLog.findUnique({ where: { reference } });
    if (!invoice) {
      return NextResponse.json({ success: false, code: "INVOICE_NOT_FOUND", error: "Invoice not found." }, { status: 404 });
    }
    if (invoice.status === "SUCCESS") {
      return NextResponse.json({ success: false, code: "INVOICE_PAID", error: "This invoice is already paid." }, { status: 409 });
    }
    if (!["PENDING", "PROCESSING_ONCHAIN", "EXPIRED"].includes(String(invoice.status))) {
      return NextResponse.json({ success: false, code: "INVOICE_NOT_PAYABLE", error: "This invoice cannot be paid." }, { status: 409 });
    }
    let rowToken: { symbol: string };
    try {
      rowToken = resolveRowCurrency(invoice);
    } catch {
      return NextResponse.json({ success: false, code: "TOKEN_UNSUPPORTED", error: "This invoice has an unsupported token." }, { status: 400 });
    }
    if (rowToken.symbol !== "USDC") {
      return NextResponse.json({ success: false, code: "TOKEN_UNSUPPORTED", error: "Cross-chain checkout is USDC-only." }, { status: 400 });
    }
    if (!invoice.merchantSCA || !isAddress(invoice.merchantSCA)) {
      return NextResponse.json({ success: false, code: "MERCHANT_WALLET_MISSING", error: "This invoice has no merchant wallet to receive the payment." }, { status: 409 });
    }

    const invoiceUnits = invoiceAmountBaseUnits(Number(invoice.amount));
    const destination = invoice.merchantSCA as string;
    const latest = (db: any) => db.flowBridgeIntent.findFirst({
      where: checkoutBridgeScope(reference),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const prior = await latest(prisma);
    const expired = (row: { status: string; expiresAt?: Date | null }) => row.status === "EXPIRED"
      || (row.expiresAt != null && row.expiresAt.getTime() <= Date.now());
    if (!prior && expired(invoice)) {
      return NextResponse.json({ success: false, code: "INVOICE_EXPIRED", error: "This invoice has expired." }, { status: 409 });
    }
    const isBound = (intent: any) => intent.sourceWallet.toLowerCase() === payerAddress.toLowerCase()
      && intent.sourceChain === source.id
      && intent.destination.toLowerCase() === destination.toLowerCase();
    const conflict = () => NextResponse.json({ success: false, code: "INTENT_STATE_CONFLICT", error: "Recover the existing payment using its original wallet and source network." }, { status: 409 });
    if (prior && !isBound(prior)) return conflict();
    const needsNewLeg = !prior || (prior.status === "COMPLETED" && prior.id === topUpAfter);
    if (topUpAfter && (!prior || (!needsNewLeg && prior.checkoutTopUpAfter !== topUpAfter))) return conflict();
    const shortfall = checkoutShortfall(invoiceUnits, await readCheckoutBridgeCredit(prisma, reference));
    let quote: Awaited<ReturnType<typeof quoteCheckoutBridge>> | null = null;
    if (needsNewLeg && shortfall > 0n) {
      try {
        quote = await quoteCheckoutBridge({ source, network, payer: payerAddress as `0x${string}`, destination: destination as `0x${string}`, shortfall });
      } catch {
        return NextResponse.json({ success: false, code: "BRIDGE_QUOTE_UNAVAILABLE", error: "A live bridge quote is unavailable. Try again before sending USDC." }, { status: 503 });
      }
    }

    const result = await (prisma as any).$transaction(async (tx: any) => {
      await lockCheckoutBridge(tx, reference);
      const current = await latest(tx);
      if (current && !isBound(current)) return null;
      const currentInvoice = await tx.paymentLog.findUnique({ where: { reference }, select: { status: true, expiresAt: true } });
      if (!currentInvoice || !["PENDING", "PROCESSING_ONCHAIN", "EXPIRED"].includes(currentInvoice.status)) return null;
      const invoiceExpired = expired(currentInvoice);
      if (current && (!topUpAfter || current.checkoutTopUpAfter === topUpAfter)) return { intent: current, reused: true, invoiceExpired };
      if (current && (current.id !== topUpAfter || current.status !== "COMPLETED")) return null;
      if (!current && invoiceExpired) return null;
      const remaining = checkoutShortfall(invoiceUnits, await readCheckoutBridgeCredit(tx, reference));
      if (!quote || remaining === 0n || shortfall !== remaining) return null;
      const intent = await tx.flowBridgeIntent.create({
        data: {
          sourceWallet: payerAddress,
          destination,
          sourceChain: source.id,
          amount: quote.gross.toString(),
          ...(current ? { checkoutTopUpReference: reference, checkoutTopUpAfter: current.id } : { invoiceReference: reference }),
          status: "PENDING",
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        },
      });
      return { intent, reused: false, invoiceExpired };
    });

    if (!result) return conflict();

    const intent = result.intent;
    if (!result.reused) {
      await logBridgeStage(intent.id, {
        stage: "PREPARING",
        chainId: source.chainId,
        metadata: {
          invoiceReference: reference,
          sourceChain: source.id,
          sourceWallet: payerAddress,
          destination,
          invoiceAmount: invoiceUnits.toString(),
          grossAmount: intent.amount,
          estimatedFee: quote?.fee.toString(),
        },
      });
    }

    return NextResponse.json({
      success: true,
      reference: intent.id,
      reused: result.reused,
      state: intent.status,
      canStart: intent.status === "PENDING" && intent.expiresAt > new Date()
        && (Boolean(intent.checkoutTopUpAfter) || !result.invoiceExpired),
      burnTxHash: intent.burnTxHash ?? null,
      mintTxHash: intent.mintTxHash ?? null,
      invoiceAmount: invoiceUnits.toString(),
      invoiceAmountDisplay: formatBridgeBaseUnits(invoiceUnits),
      amount: intent.amount,
      amountDisplay: formatBridgeBaseUnits(BigInt(intent.amount)),
      destination,
      source: {
        id: source.id,
        label: source.label,
        chainId: source.chainId,
        usdcAddress: source.usdcAddress,
      },
      expiresAt: intent.expiresAt,
    });
  } catch (error: any) {
    console.error("[checkout/bridge/intent]", error);
    return NextResponse.json({ success: false, error: "Could not start the cross-chain payment." }, { status: 500 });
  }
}
