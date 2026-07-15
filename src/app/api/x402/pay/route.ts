// src/app/api/x402/pay/route.ts — DEFINITIVE FINAL
// Uses BUYER_PRIVATE_KEY (0x0f9e...) via GatewayClient.
// chain: "arcTestnet" is correct for GatewayClient (buyer side only).

import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";

export async function POST(req: NextRequest) {
  try {
    const { resourceUrl, eoaAddress } = await req.json();

    if (!resourceUrl) {
      return NextResponse.json(
        { success: false, error: "Missing resourceUrl" },
        { status: 400 }
      );
    }

    const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
    if (!PRIVATE_KEY) {
      return NextResponse.json(
        { success: false, error: "BUYER_PRIVATE_KEY not set" },
        { status: 500 }
      );
    }

    console.log(`[x402 pay] Paying: ${resourceUrl}`);
    console.log(`[x402 pay] Buyer: ${eoaAddress || process.env.BUYER_ADDRESS}`);

    const client = new GatewayClient({
      chain: "arcTestnet",    // ✅ "arcTestnet" is correct for GatewayClient buyer
      privateKey: PRIVATE_KEY,
    });

    // Check Gateway balance before paying
    let balances: any;
    try {
      balances = await client.getBalances();
      const available = balances?.gateway?.formattedAvailable ?? "0";
      console.log(`[x402 pay] Gateway balance: ${available} USDC`);
      if (parseFloat(available) <= 0) {
        return NextResponse.json({
          success: false,
          error: "No Gateway balance. Deposit first via: circle gateway deposit --address " +
            process.env.BUYER_ADDRESS + " --chain ARC-TESTNET --amount 10",
          walletBalance: balances?.wallet?.formatted ?? "0",
          gatewayBalance: "0",
        }, { status: 400 });
      }
    } catch (balErr: any) {
      console.warn("[x402 pay] Could not check balance:", balErr.message);
    }

    const response = await client.pay(resourceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      validity: {
        maxSeconds: 604800,   // 7 days – accepted by seller
      },
    });

    console.log(`[x402 pay] Success! TX: ${response.transaction}`);

    return NextResponse.json({
      success: true,
      transaction: response.transaction,
      amountUSDC: response.formattedAmount,
      paidWith: process.env.BUYER_ADDRESS,
      resourceData: response.data,
    });
  } catch (error: any) {
    console.error("[x402 pay] Error:", error.message);
    if (error.cause) console.error("[x402 pay] Cause:", error.cause);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}