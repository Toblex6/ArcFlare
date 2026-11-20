// src/app/api/checkout/[reference]/bridge/intent/route.ts
//
// Checkout cross-chain intent. One invoice → exactly one durable
// FlowBridgeIntent row (unique invoiceReference). The payer's wallet signs the
// source-chain burn via Circle Bridge Kit in the browser; this server route
// never signs or broadcasts. The mint recipient is ALWAYS the invoice's
// merchant address, resolved from the frozen PaymentLog row — never the body.
//
// The burn amount is grossed up by a server-configured buffer so the merchant's
// measured Arc credit is >= the invoice amount even after the CCTP relay fee.

import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { getArcNetworkName } from "@/lib/config/network";
import { resolveRowCurrency } from "@/lib/tokens/resolveCurrency";
import { getBridgeSourceChain, formatBridgeBaseUnits } from "@/lib/bridge/sourceChains";
import { logBridgeStage } from "@/lib/bridge/stageLogger";
import {
  invoiceAmountBaseUnits,
  grossUpInvoiceAmount,
  parseCheckoutBridgeFeeBps,
} from "@/lib/checkout/bridgeGross";

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
    if (invoice.status === "EXPIRED" || (invoice.expiresAt && new Date(invoice.expiresAt).getTime() <= Date.now())) {
      return NextResponse.json({ success: false, code: "INVOICE_EXPIRED", error: "This invoice has expired." }, { status: 409 });
    }
    if (!["PENDING", "PROCESSING_ONCHAIN"].includes(String(invoice.status))) {
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
    let leaseBps: number;
    try {
      leaseBps = parseCheckoutBridgeFeeBps(process.env.ARC_CHECKOUT_BRIDGE_FEE_BPS);
    } catch (e: any) {
      return NextResponse.json({ success: false, code: "BRIDGE_FEE_MISCONFIGURED", error: e.message }, { status: 503 });
    }
    const grossUnits = grossUpInvoiceAmount(invoiceUnits, leaseBps);
    const destination = invoice.merchantSCA as string;

    const result = await (prisma as any).$transaction(async (tx: any) => {
      // Serialize intent creation per invoice so two tabs cannot create two
      // burns for the same invoice (one burn settles exactly one invoice).
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `checkout-bridge:${reference}`);
      let intent = await tx.flowBridgeIntent.findUnique({ where: { invoiceReference: reference } });
      if (intent) {
        const same = intent.sourceWallet.toLowerCase() === payerAddress.toLowerCase()
          && intent.sourceChain === source.id
          && intent.destination.toLowerCase() === destination.toLowerCase()
          && intent.amount === grossUnits.toString();
        return { intent, reused: true, mismatch: !same };
      }
      intent = await tx.flowBridgeIntent.create({
        data: {
          sourceWallet: payerAddress,
          destination,
          sourceChain: source.id,
          amount: grossUnits.toString(),
          invoiceReference: reference,
          status: "PENDING",
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        },
      });
      return { intent, reused: false, mismatch: false };
    });

    if (result.mismatch) {
      return NextResponse.json(
        { success: false, code: "INTENT_STATE_CONFLICT", error: "This invoice already has a cross-chain payment in progress from a different wallet, source or amount. Recover that payment; do not start another burn." },
        { status: 409 }
      );
    }

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
          grossAmount: grossUnits.toString(),
          feeBufferBps: leaseBps,
        },
      });
    }

    return NextResponse.json({
      success: true,
      reference: intent.id,
      reused: result.reused,
      state: intent.status,
      burnTxHash: intent.burnTxHash ?? null,
      mintTxHash: intent.mintTxHash ?? null,
      invoiceAmount: invoiceUnits.toString(),
      invoiceAmountDisplay: formatBridgeBaseUnits(invoiceUnits),
      amount: grossUnits.toString(),
      amountDisplay: formatBridgeBaseUnits(grossUnits),
      feeBufferBps: leaseBps,
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
