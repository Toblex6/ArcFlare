// src/app/api/x402/eoa-wallet/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// ── POST /api/x402/eoa-wallet ─────────────────────────────────────────────
async function createEoaWalletHandler(request: Request) {
  try {
    const { label } = await request.json().catch(() => ({}));

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const saved = await prisma.x402EoaWallet.create({
      data: {
        address: account.address,
        privateKey,
        label: label || null,
      },
    });

    return NextResponse.json({
      success: true,
      wallet: {
        address: saved.address,
        label: saved.label,
        id: saved.id,
      },
      message: `EOA wallet created: ${account.address}. Fund it with USDC on Arc Testnet.`,
      nextSteps: [
        `Fund via faucet: https://faucet.circle.com (paste ${account.address})`,
        `Pay an x402 endpoint: POST /api/x402/pay { "resourceUrl": "...", "eoaAddress": "${account.address}" }`,
      ],
    });
  } catch (error: any) {
    console.error("❌ EOA wallet creation error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(createEoaWalletHandler);

// ── GET /api/x402/eoa-wallet?address=0x... ──────────────────────────────
async function getEoaWalletHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");

    if (!address) {
      return NextResponse.json({ success: false, error: "address query param required." }, { status: 400 });
    }

    const wallet = await prisma.x402EoaWallet.findUnique({ where: { address } });

    if (!wallet) {
      return NextResponse.json({ success: false, error: "EOA wallet not found." }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      wallet: { address: wallet.address, label: wallet.label, id: wallet.id, createdAt: wallet.createdAt },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(getEoaWalletHandler);