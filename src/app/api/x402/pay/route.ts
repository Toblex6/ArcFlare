/**
 * src/app/api/x402/pay/route.ts
 *
 * REBUILT using the ACTUAL @circle-fin/x402-batching SDK's GatewayClient,
 * per the official SDK Reference. Replaces the hand-rolled EIP-3009
 * signing code from earlier today.
 *
 * GatewayClient.pay(url, options) "handles the full 402 negotiation flow
 * automatically: sends the request, receives payment requirements, signs
 * the authorization, and retries with the payment header." — straight
 * from the SDK docs. No manual typed-data construction needed at all.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { GatewayClient } from "@circle-fin/x402-batching/client";

interface PayRequest {
  resourceUrl: string;
  eoaAddress: string;
}

async function payWithEoaHandler(request: Request) {
  try {
    const { resourceUrl, eoaAddress }: PayRequest = await request.json();

    if (!resourceUrl || !eoaAddress) {
      return NextResponse.json(
        { success: false, error: "resourceUrl and eoaAddress are required." },
        { status: 400 }
      );
    }

    const walletRecord = await (prisma as any).x402EoaWallet.findUnique({ where: { address: eoaAddress } });
    if (!walletRecord) {
      return NextResponse.json(
        { success: false, error: `No stored EOA wallet for ${eoaAddress}.` },
        { status: 404 }
      );
    }

    // Per SDK docs: config.chain uses SupportedChainName values like
    // 'arcTestnet' — this is the CLIENT constructor's chain selector,
    // distinct from the eip155:5042002 CAIP-2 network format used inside
    // payment requirements JSON. Both are correct; they serve different roles.
    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: walletRecord.privateKey as `0x${string}`,
    });

    // Check Gateway balance first — nanopayments require a Gateway deposit,
    // not just a wallet balance (per SDK: "Buyers fund their payments from
    // a Gateway Wallet balance (deposited once onchain)").
    const balances = await client.getBalances();

    if (parseFloat(balances.gateway.formattedAvailable) <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No Gateway balance available. Deposit USDC into Gateway first.",
          walletBalance: balances.wallet.formatted,
          gatewayBalance: balances.gateway.formattedAvailable,
          nextStep: `POST /api/x402/eoa-wallet/deposit { "eoaAddress": "${eoaAddress}", "amount": "10" }`,
        },
        { status: 400 }
      );
    }

    // The SDK's pay() does everything: probe, sign, retry. No manual
    // EIP-712 construction, no manual base64 encoding.
    const result = await client.pay(resourceUrl, { method: "POST" });

    return NextResponse.json({
      success: true,
      paidWith: client.address,
      amountUSDC: result.formattedAmount,
      transaction: result.transaction,
      resourceData: result.data,
      message: `Paid ${result.formattedAmount} USDC from EOA ${client.address} for ${resourceUrl}`,
    });
  } catch (error: any) {
    console.error("❌ x402 payment error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(payWithEoaHandler);