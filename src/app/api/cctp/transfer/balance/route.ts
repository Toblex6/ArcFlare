// src/app/api/cctp/transfer/balance/route.ts
// Per-chain USDC balance for the consumer bridge view. Server-signed
// (CIRCLE developer-controlled) wallets are read via their bound Circle
// wallet id; anything else fails closed with the EXTERNAL_WALLET code so
// the UI can show its "create a wallet" upgrade flow.
import { NextRequest, NextResponse } from "next/server";
import { getCctpSources } from "@/lib/cctp-v2";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { getWalletBalance } from "@/src/lib/circle/client";
import { getNetworkConfig } from "@/lib/config/network";
import { prisma } from "@/src/lib/prisma";
import { signingModelForWallet } from "@/src/lib/wallet/signingModel";

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

    const source = getCctpSources().find((c) => c.id === fromChain);
    if (!source) {
      return NextResponse.json(
        { success: false, error: `Unsupported source chain: ${fromChain}` },
        { status: 400 }
      );
    }

    const account = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress },
    });
    const model = signingModelForWallet(account);

    if (model !== "server-signed") {
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

    // The consumer wallet model carries no wallet-set binding: only the Arc
    // balance (the chain the wallet is provisioned on) is readable here.
    const arcBlockchain = getNetworkConfig().circleBlockchain;
    if (source.circleBlockchain !== arcBlockchain) {
      return NextResponse.json({
        success: false,
        code: "BRIDGE_SOURCE_UNSUPPORTED",
        error: `Balance on ${source.label ?? fromChain} is not available for this wallet — fund your FlareHQ wallet on Arc first.`,
      });
    }

    const balance = await getWalletBalance(account.circleWalletId);

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
