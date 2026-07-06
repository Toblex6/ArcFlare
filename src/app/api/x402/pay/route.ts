// src/app/api/x402/pay/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";

export async function POST(req: NextRequest) {
  try {
    const { resourceUrl, eoaAddress } = await req.json();
    if (!resourceUrl || !eoaAddress) {
      return NextResponse.json(
        { success: false, error: "Missing resourceUrl or eoaAddress" },
        { status: 400 }
      );
    }

    // Use EOA_PRIVATE_KEY (set in .env) – this should be the key for the address with Gateway balance
    const PRIVATE_KEY = process.env.EOA_PRIVATE_KEY as `0x${string}`;
    if (!PRIVATE_KEY) {
      return NextResponse.json(
        { success: false, error: "EOA_PRIVATE_KEY not set" },
        { status: 500 }
      );
    }

    console.log(`[x402 pay] Using EOA: ${eoaAddress}`);
    console.log(`[x402 pay] Resource URL: ${resourceUrl}`);

    const client = new GatewayClient({
      chain: "arcTestnet",        // ✅ buyer uses "arcTestnet"
      privateKey: PRIVATE_KEY,
    });

    const response = await client.pay(resourceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    console.log(`[x402 pay] Payment successful: ${response.transaction}`);

    return NextResponse.json({
      success: true,
      amountUSDC: response.amount ? (Number(response.amount) / 1e6).toString() : undefined,
      transaction: response.transaction,
      paidWith: eoaAddress,
      resourceData: response.data,
    });
  } catch (error: any) {
    console.error("[x402 pay] Error:", error.message);
    // If there's a response from the Gateway, include it
    const details = error.response?.data || error;
    return NextResponse.json(
      { success: false, error: error.message, details },
      { status: 500 }
    );
  }
}