// src/app/api/cctp/transfer/balance/route.ts
// Per-chain USDC balance for the consumer bridge view. The consumer's Circle
// wallet shares one address across the wallet set's chains, but each chain has
// its own wallet *resource* (and its own token balances) — so the available
// balance for bridging FROM Arbitrum Sepolia etc. must be read from that
// chain's wallet, not from the Arc balance the home dashboard shows.
import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { getCctpSources } from "@/lib/cctp-v2";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { ensureWalletOnChain, getWalletBalance } from "@/src/lib/circle/client";
import { prisma } from "@/src/lib/prisma";
import { signingModelForWallet } from "@/src/lib/wallet/signingModel";
import {
  minorToDisplay,
  readSourceUsdcBalance,
  resolveSourceChainBinding,
} from "@/lib/circle/userBridge";

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

    // USER_CONTROLLED wallets bridge via browser-executed challenges, so
    // the source-chain balance is read straight from the chain (USDC
    // balanceOf of the session address) — no Circle API call, no userToken,
    // no wallet-set resource needed for a read.
    if (model === "user-controlled-challenge") {
      try {
        const binding = resolveSourceChainBinding(fromChain);
        const balanceMinor = await readSourceUsdcBalance({
          sourceId: binding.sourceId,
          usdc: binding.usdcAddress,
          owner: getAddress(walletAddress),
        });
        return NextResponse.json({
          success: true,
          balance: minorToDisplay(balanceMinor),
          chain: source.id,
          chainLabel: source.label,
        });
      } catch (e: any) {
        const status =
          typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
        return NextResponse.json(
          {
            success: false,
            ...(e?.code ? { code: e.code } : {}),
            error: e?.message ?? "Could not load balance for this chain.",
          },
          { status }
        );
      }
    }

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