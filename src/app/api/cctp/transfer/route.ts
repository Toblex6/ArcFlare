// src/app/api/cctp/transfer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { startBridge, getCctpSources, getCctpDestinations } from "@/lib/cctp-v2";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import { getNetworkConfig } from "@/lib/config/network";
import { prisma } from "@/src/lib/prisma";
import { resolveConsumerWallet } from "@/src/lib/auth/consumerWallet";
import {
  bridgeEnabled,
  signingModelForWallet,
} from "@/src/lib/wallet/signingModel";

export async function POST(req: NextRequest) {
  try {
    // Who's paying comes from the session, never the request body — the
    // whole point of the per-user-wallet design is that we bridge FROM the
    // logged-in consumer's own Circle wallet, not whatever address a client
    // claims.
    const consumerWalletAddress = await resolveConsumerSession(req);
    if (!consumerWalletAddress) {
      return NextResponse.json(
        { success: false, error: "Sign in required to bridge funds." },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { fromChain, toChain, amount, recipient } = body;

    if (!fromChain || !toChain || !amount || !recipient) {
      return NextResponse.json(
        { success: false, error: "Missing fields: fromChain, toChain, amount, recipient" },
        { status: 400 }
      );
    }

    const source = getCctpSources().find((c) => c.id === fromChain);
    if (!source) {
      return NextResponse.json(
        { success: false, error: `Unsupported source chain: ${fromChain}` },
        { status: 400 }
      );
    }

    const destExists = getCctpDestinations().some((c) => c.id === toChain);
    if (!destExists) {
      return NextResponse.json(
        { success: false, error: `Unsupported destination chain: ${toChain}` },
        { status: 400 }
      );
    }

    const account = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress: consumerWalletAddress },
    });

    // Canonical consumer wallet model first: legacy/unknown custody fails
    // closed here (403) — it never reaches the signing decision below.
    const wallet = resolveConsumerWallet(account);
    if (!wallet) {
      return NextResponse.json(
        {
          success: false,
          code: 'WALLET_UNSUPPORTED',
          error: "This wallet type is no longer supported for bridging.",
        },
        { status: 403 }
      );
    }

    // CIRCLE rows with no bound signing identity fail closed with a
    // recoverable state — never invented wallets, never shared ones.
    if (wallet.mode === 'CIRCLE' && !wallet.canServerSign) {
      return NextResponse.json(
        {
          success: false,
          code: 'CIRCLE_WALLET_UNBOUND',
          error: "This FlareHQ wallet has no bound signing identity — bridging is unavailable until it is repaired.",
        },
        { status: 400 }
      );
    }

    // Signing model decides HOW this wallet bridges — never a raw
    // walletType string comparison. Only server-signed (CIRCLE
    // developer-controlled) wallets bridge automatically; everything else
    // fails closed.
    const model = signingModelForWallet(account);
    if (!account || !bridgeEnabled(model)) {
      return NextResponse.json(
        {
          success: false,
          code: 'EXTERNAL_WALLET',
          error: "Bridging currently requires a FlareHQ-created wallet — external (bring-your-own) wallets can't be bridged from automatically.",
        },
        { status: 400 }
      );
    }

    // Consumer step-up (Stage 2): bridging moves funds off the consumer's
    // own wallet — a session alone is not sufficient once enrolled.
    const bridgeStepUp = await requireConsumerStepUp(req, account, 'consumer.bridge');
    if (bridgeStepUp) return bridgeStepUp;

    // The consumer's Circle wallet is provisioned on Arc at signup. The
    // consumer wallet model carries no wallet-set binding, so cross-chain
    // source provisioning is out of scope: bridging FROM a non-Arc chain
    // is refused explicitly rather than failing silently downstream.
    const arcBlockchain = getNetworkConfig().circleBlockchain;
    if (source.circleBlockchain !== arcBlockchain) {
      return NextResponse.json(
        {
          success: false,
          code: 'BRIDGE_SOURCE_UNSUPPORTED',
          error: `Bridging from ${source.label ?? fromChain} is not supported for this wallet — fund your FlareHQ wallet on Arc first.`,
        },
        { status: 400 }
      );
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(String(recipient ?? ""))) {
      return NextResponse.json(
        { success: false, error: "Recipient must be a valid 0x address." },
        { status: 400 }
      );
    }

    const { reference } = startBridge({
      fromChain,
      toChain,
      amount,
      senderAddress: getAddress(consumerWalletAddress) as `0x${string}`,
      recipientAddress: getAddress(recipient),
    });

    return NextResponse.json({
      success: true,
      status: "pending",
      reference,
      message: "Bridge started — poll /api/cctp/transfer/status?reference=... to check progress.",
    });
  } catch (error: any) {
    console.error("[CCTP Bridge]", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    sourceChains: getCctpSources(),
    destinationChains: getCctpDestinations(),
  });
}
