// src/app/api/x402/seller/withdraw/route.ts
//
// Seller Gateway withdrawal — using GatewayClient.withdraw() exactly per
// the confirmed real pattern from circlefin/arc-nanopayments:
//
//   const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: SELLER_PRIVATE_KEY });
//   const result = await gateway.withdraw(amount, { chain: destinationChain, recipient });
//
// Supports same-chain (instant) and cross-chain withdrawals, per SDK docs.

import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { GatewayClient } from "@circle-fin/x402-batching/client";

async function withdrawHandler(request: Request) {
  try {
    const { amount, destinationChain, destinationAddress } = await request.json();

    const sellerPrivateKey = process.env.SELLER_PRIVATE_KEY;
    if (!sellerPrivateKey) {
      return NextResponse.json({ success: false, error: "SELLER_PRIVATE_KEY not configured." }, { status: 500 });
    }

    if (!amount) {
      return NextResponse.json({ success: false, error: "amount is required." }, { status: 400 });
    }

    const gateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: sellerPrivateKey as `0x${string}`,
    });

    const result = await gateway.withdraw(amount.toString(), {
      chain: destinationChain || "arcTestnet",
      recipient: destinationAddress ? (destinationAddress as `0x${string}`) : undefined,
    });

    return NextResponse.json({
      success: true,
      txHash: result.mintTxHash,
      amount: result.formattedAmount,
      sourceChain: result.sourceChain,
      destinationChain: result.destinationChain,
      recipient: result.recipient,
      status: "confirmed",
      explorerUrl: `https://testnet.arcscan.app/tx/${result.mintTxHash}`,
    });
  } catch (error: any) {
    console.error("❌ Gateway withdraw error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(withdrawHandler);