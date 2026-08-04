// src/app/api/x402/eoa-wallet/deposit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { withApiKeyOrMerchant, resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getOrCreateBuyerWallet } from "@/lib/x402-wallet";

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

// POST — deposit USDC into Gateway, for the caller's OWN wallet
async function depositPostHandler(req: NextRequest) {
  try {
    const { amount } = await req.json();
    if (!amount) {
      return NextResponse.json(
        { success: false, error: "Missing amount" },
        { status: 400 }
      );
    }

    const merchant = await resolveMerchant(req);
    if (!merchant) {
      return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
    }

    const wallet = await getOrCreateBuyerWallet(merchant.id);

    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: wallet.privateKey,
    });

    const result = await client.deposit(amount.toString());

    return NextResponse.json(sanitizeBigInts({
      success: true,
      depositTxHash: result.depositTxHash,
      approvalTxHash: result.approvalTxHash || null,
      amountDeposited: result.formattedAmount,
      explorerUrl: `https://testnet.arcscan.app/tx/${result.depositTxHash}`,
      message: `Deposited ${result.formattedAmount} USDC into Gateway for ${wallet.address}.`,
    }));
  } catch (error: any) {
    console.error("Deposit error:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// GET — check the CALLER's own Gateway + wallet balance
async function depositGetHandler(req: NextRequest) {
  try {
    const merchant = await resolveMerchant(req);
    if (!merchant) {
      return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
    }

    const wallet = await getOrCreateBuyerWallet(merchant.id);
    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: wallet.privateKey,
    });

    const balances = await client.getBalances();

    return NextResponse.json(sanitizeBigInts({
      success: true,
      address: wallet.address,
      balances,
    }));
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
export const POST = withApiKeyOrMerchant(depositPostHandler);
export const GET = withApiKeyOrMerchant(depositGetHandler);
