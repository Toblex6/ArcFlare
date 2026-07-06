// src/app/api/x402/eoa-wallet/deposit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { parseUnits } from "viem";

export async function POST(req: NextRequest) {
  try {
    const { eoaAddress, amount } = await req.json();
    if (!eoaAddress || !amount) {
      return NextResponse.json(
        { success: false, error: "Missing eoaAddress or amount" },
        { status: 400 }
      );
    }

    const PRIVATE_KEY = process.env.EOA_PRIVATE_KEY as `0x${string}`;
    if (!PRIVATE_KEY) {
      return NextResponse.json(
        { success: false, error: "EOA_PRIVATE_KEY not set" },
        { status: 500 }
      );
    }

    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: PRIVATE_KEY,
    });

    const amountAtomic = parseUnits(amount, 6);
    // Generate deposit payload – this returns a deposit URI (EIP-681) and QR code data
    const depositPayload = await client.gateway.deposit({
      amount: amountAtomic,
      // Optionally specify recipient account (default is the EOA's Gateway account)
    });

    return NextResponse.json({
      success: true,
      depositUri: depositPayload.uri,
      amount,
      message: `Send ${amount} USDC to the Gateway using the provided URI.`,
    });
  } catch (error: any) {
    console.error("Deposit error:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}