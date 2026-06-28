// src/app/api/x402/eoa-wallet/deposit/route.ts
// Deposits USDC from an EOA's wallet balance into its Gateway balance.
// Uses GatewayClient.deposit() per the official SDK Reference — this is
// an onchain transaction (requires gas) that funds the gasless nanopayment
// balance used by client.pay() afterward.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { GatewayClient } from "@circle-fin/x402-batching/client";

// NextResponse.json() cannot serialize BigInt — the SDK's Balances type
// declares `balance: bigint` on both wallet and gateway objects. Recursively
// stringify any BigInt before responding.
function sanitizeBigInts(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeBigInts);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitizeBigInts(v)]));
  }
  return obj;
}

async function depositHandler(request: Request) {
  try {
    const { eoaAddress, amount } = await request.json();

    if (!eoaAddress || !amount) {
      return NextResponse.json(
        { success: false, error: "eoaAddress and amount are required." },
        { status: 400 }
      );
    }

    const walletRecord = await (prisma as any).x402EoaWallet.findUnique({ where: { address: eoaAddress } });
    if (!walletRecord) {
      return NextResponse.json({ success: false, error: "EOA wallet not found." }, { status: 404 });
    }

    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: walletRecord.privateKey as `0x${string}`,
    });

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
    console.error("❌ Gateway deposit error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(depositHandler);

// ── GET — check balances (wallet + Gateway) ───────────────────────────────────
async function getBalancesHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const eoaAddress = searchParams.get("eoaAddress");

    if (!eoaAddress) {
      return NextResponse.json({ success: false, error: "eoaAddress query param required." }, { status: 400 });
    }

    const walletRecord = await (prisma as any).x402EoaWallet.findUnique({ where: { address: eoaAddress } });
    if (!walletRecord) {
      return NextResponse.json({ success: false, error: "EOA wallet not found." }, { status: 404 });
    }

    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: walletRecord.privateKey as `0x${string}`,
    });

    const balances = await client.getBalances();

    return NextResponse.json(sanitizeBigInts({ success: true, balances }));
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(getBalancesHandler);