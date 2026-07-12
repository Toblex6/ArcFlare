// src/app/api/x402/eoa-wallet/deposit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";

function sanitizeBigInts(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeBigInts);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sanitizeBigInts(v)])
    );
  }
  return obj;
}

// POST — deposit USDC into Gateway
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

    // ✅ correct method — client.deposit(amountString)
    const result = await client.deposit(amount.toString());

    return NextResponse.json(sanitizeBigInts({
      success: true,
      depositTxHash: result.depositTxHash,
      approvalTxHash: result.approvalTxHash || null,
      amountDeposited: result.formattedAmount,
      explorerUrl: `https://testnet.arcscan.app/tx/${result.depositTxHash}`,
      message: `Deposited ${result.formattedAmount} USDC into Gateway for ${eoaAddress}.`,
    }));
  } catch (error: any) {
    console.error("Deposit error:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// GET — check Gateway + wallet balance
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const eoaAddress = searchParams.get("eoaAddress");

    if (!eoaAddress) {
      return NextResponse.json(
        { success: false, error: "eoaAddress query param required" },
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

    const balances = await client.getBalances();

    return NextResponse.json(sanitizeBigInts({
      success: true,
      address: eoaAddress,
      balances,
    }));
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}