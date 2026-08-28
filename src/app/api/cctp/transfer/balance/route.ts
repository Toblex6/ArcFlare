// src/app/api/cctp/transfer/balance/route.ts
// Per-chain USDC balance for the consumer bridge view. The consumer's Circle
// wallet shares one address across the wallet set's chains, but each chain has
// its own wallet *resource* (and its own token balances) — so the available
// balance for bridging FROM Arbitrum Sepolia etc. must be read from that
// chain's wallet, not from the Arc balance the home dashboard shows.
import { NextRequest, NextResponse } from "next/server";
import { CCTP_SOURCE_CHAINS } from "@/lib/cctp-v2";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { ensureWalletOnChain, getWalletBalance } from "@/src/lib/circle/client";
import { prisma } from "@/src/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const walletAddress = await resolveConsumerSession(req);
    if (!walletAddress) {
      return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    }

    const fromChain = req.nextUrl.searchParams.get("fromChain");
    if (!fromChain) {
      return NextResponse.json({ success: false, error: "Missing fromChain." }, { status: 400 });
    }

    const source = CCTP_SOURCE_CHAINS.find((c) => c.id === fromChain);
    if (!source) {
      return NextResponse.json(
        { success: false, error: `Unsupported source chain: ${fromChain}` },
        { status: 400 }
      );
    }

    const account = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress },
    });
    if (!account || account.walletType !== "CIRCLE" || !account.walletSetId) {
      // Same constraint as the bridge POST itself — without a FlareHQ-managed
      // wallet there's nothing we can read (or bridge from) on the source chain.
      // 200 with a code (not a 4xx) so the UI can show its "create a wallet"
      // upgrade flow without treating it as a transport error.
      return NextResponse.json({
        success: false,
        code: "EXTERNAL_WALLET",
        error:
          "Bridging needs a FlareHQ-created wallet. Create one below — it takes a second and you can keep using your connected wallet normally.",
      });
    }

    // Lazily provision the wallet on the source chain (same address) so the
    // balance read matches exactly what the bridge will spend from.
    const wallet = await ensureWalletOnChain(account.walletSetId, source.circleBlockchain);
    const balance = await getWalletBalance(wallet.id);

    return NextResponse.json({
      success: true,
      balance,
      chain: source.id,
      chainLabel: source.label,
    });
  } catch (error: any) {
    console.error("[cctp/transfer/balance]", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}