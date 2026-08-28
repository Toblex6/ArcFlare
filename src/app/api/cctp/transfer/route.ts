// src/app/api/cctp/transfer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { startBridge, CCTP_SOURCE_CHAINS, CCTP_DEST_CHAINS } from "@/lib/cctp-v2";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { ensureWalletOnChain } from "@/src/lib/circle/client";
import { prisma } from "@/src/lib/prisma";

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

    const source = CCTP_SOURCE_CHAINS.find((c) => c.id === fromChain);
    if (!source) {
      return NextResponse.json(
        { success: false, error: `Unsupported source chain: ${fromChain}` },
        { status: 400 }
      );
    }

    const destExists = CCTP_DEST_CHAINS.some((c) => c.id === toChain);
    if (!destExists) {
      return NextResponse.json(
        { success: false, error: `Unsupported destination chain: ${toChain}` },
        { status: 400 }
      );
    }

    const account = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress: consumerWalletAddress },
    });

    if (!account || account.walletType !== 'CIRCLE' || !account.walletSetId) {
      return NextResponse.json(
        {
          success: false,
          code: 'EXTERNAL_WALLET',
          error: "Bridging currently requires a FlareHQ-created wallet — external (bring-your-own) wallets can't be bridged from automatically.",
        },
        { status: 400 }
      );
    }

    // The consumer's wallet is only provisioned on Arc at signup. Add it to
    // the requested source chain the first time they bridge from there —
    // same address (Circle SCA wallets share an address across a wallet
    // set's chains), just a new signable resource on that specific chain.
    await ensureWalletOnChain(account.walletSetId, source.circleBlockchain);

    const { reference } = startBridge({
      fromChain,
      toChain,
      amount,
      senderAddress: consumerWalletAddress as `0x${string}`,
      recipientAddress: recipient,
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
    sourceChains: CCTP_SOURCE_CHAINS,
    destinationChains: CCTP_DEST_CHAINS,
  });
}
