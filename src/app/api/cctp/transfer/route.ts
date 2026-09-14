// src/app/api/cctp/transfer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { startBridge, getCctpSources, getCctpDestinations } from "@/lib/cctp-v2";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import { ensureWalletOnChain } from "@/src/lib/circle/client";
import { prisma } from "@/src/lib/prisma";
import {
  bridgeEnabled,
  signingModelForWallet,
} from "@/src/lib/wallet/signingModel";
import {
  buildBridgeQuote,
  createApproveChallenge,
  createBurnChallenge,
  createProvisionChallenge,
  makeUserBridgeReference,
  readSourceAllowance,
  readSourceUsdcBalance,
  resolveUserSourceWallet,
  setUserBridgeIntent,
  type CctpSourceChainId,
  type UserBridgeIntent,
} from "@/lib/circle/userBridge";

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
    const { fromChain, toChain, amount, recipient, userToken } = body;

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

    // Signing model decides HOW this wallet bridges — never a raw
    // walletType string comparison (a CIRCLE row without walletSetId is
    // not server-signable and must fail closed, not bridge).
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

    if (model === 'user-controlled-challenge') {
      return handleUserControlledBridge({
        fromChain,
        toChain,
        amount,
        recipient,
        userToken,
        consumerWalletAddress,
        circleBlockchain: source.circleBlockchain,
      });
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

// ── USER_CONTROLLED path: server-orchestrated, browser-executed ─────────────
// The server builds every byte of calldata and creates Circle challenges;
// the browser executes each challengeId through the Web SDK. The CIRCLE
// (server-signed) path above is untouched. The per-request `userToken`
// authenticates to Circle only — it is never logged or persisted.
async function handleUserControlledBridge(args: {
  fromChain: string;
  toChain: string;
  amount: string;
  recipient: string;
  userToken: unknown;
  consumerWalletAddress: string;
  circleBlockchain: string;
}) {
  const { fromChain, toChain, amount, recipient, consumerWalletAddress, circleBlockchain } = args;
  try {
    if (typeof args.userToken !== "string" || args.userToken.trim().length < 16) {
      return NextResponse.json(
        {
          success: false,
          code: "USER_TOKEN_REQUIRED",
          error: "Bridging from your FlareHQ wallet needs a fresh Circle sign-in — sign in again and retry.",
        },
        { status: 401 }
      );
    }
    const userToken = args.userToken.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(recipient ?? ""))) {
      return NextResponse.json(
        { success: false, error: "Recipient must be a valid 0x address." },
        { status: 400 }
      );
    }
    const recipientAddress = getAddress(recipient);
    const senderAddress = getAddress(consumerWalletAddress);

    // Server-trusted quote: amount validated, source binding from
    // bridge-kit, destination domain overlapped against network config.
    const quote = buildBridgeQuote({ fromChain, amount });
    const sourceId = quote.binding.sourceId as CctpSourceChainId;

    // Trust anchor: the session address must be among the Circle wallets
    // for THIS userToken. Missing source-chain resource → provision
    // challenge (browser executes, then retries this call).
    let walletId: string;
    try {
      const resolved = await resolveUserSourceWallet({
        userToken,
        sessionAddress: senderAddress,
        circleBlockchain,
      });
      walletId = resolved.wallet.id;
    } catch (e: any) {
      if (e?.code === "WALLET_NOT_ON_CHAIN") {
        const { challengeId } = await createProvisionChallenge({ userToken, circleBlockchain });
        return NextResponse.json({
          success: true,
          state: "needs-provision",
          challengeId,
          blockchain: circleBlockchain,
          message:
            "Your wallet needs activating on the source chain first — approve the Circle prompt, then retry the bridge.",
        });
      }
      throw e;
    }

    // Fail fast on insufficient source balance before creating challenges.
    const balance = await readSourceUsdcBalance({
      sourceId,
      usdc: quote.binding.usdcAddress,
      owner: senderAddress,
    });
    if (balance < quote.amountMinor) {
      return NextResponse.json(
        {
          success: false,
          code: "INSUFFICIENT_BALANCE",
          error: `Insufficient USDC on the source chain for this bridge (need ${quote.amountMinor} minor units).`,
        },
        { status: 400 }
      );
    }

    const reference = makeUserBridgeReference();

    // Allowance gate: challenge an approve only when the TokenMessenger
    // allowance is insufficient for the full burn amount.
    const allowance = await readSourceAllowance({
      sourceId,
      usdc: quote.binding.usdcAddress,
      owner: senderAddress,
      spender: quote.binding.tokenMessenger,
    });
    if (allowance < quote.amountMinor) {
      const { challengeId } = await createApproveChallenge({
        userToken,
        walletId,
        circleBlockchain,
        tokenMessenger: quote.binding.tokenMessenger,
        usdcAddress: quote.binding.usdcAddress,
        amountMinor: quote.amountMinor,
        refId: reference,
      });
      const intent: UserBridgeIntent = {
        reference,
        state: "needs-approval",
        fromChain: sourceId,
        toChain,
        amountMinor: quote.amountMinor.toString(),
        maxFeeMinor: quote.maxFeeMinor.toString(),
        minFinalityThreshold: quote.minFinalityThreshold,
        senderAddress,
        recipientAddress,
        sourceDomain: quote.binding.sourceDomain,
        destinationDomain: quote.destinationDomain,
        tokenMessenger: quote.binding.tokenMessenger,
        usdcAddress: quote.binding.usdcAddress,
        circleBlockchain,
        walletId,
        pendingChallengeId: challengeId,
        pendingPurpose: "approve",
        burnTxHash: null,
        balanceBeforeMinor: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setUserBridgeIntent(intent);
      return NextResponse.json({
        success: true,
        state: "needs-approval",
        reference,
        challengeId,
        message: "Approve USDC spending in the Circle prompt, then continue.",
      });
    }

    const { challengeId } = await createBurnChallenge({
      userToken,
      walletId,
      circleBlockchain,
      quote,
      mintRecipient: recipientAddress,
      refId: reference,
    });
    const intent: UserBridgeIntent = {
      reference,
      state: "needs-burn",
      fromChain: sourceId,
      toChain,
      amountMinor: quote.amountMinor.toString(),
      maxFeeMinor: quote.maxFeeMinor.toString(),
      minFinalityThreshold: quote.minFinalityThreshold,
      senderAddress,
      recipientAddress,
      sourceDomain: quote.binding.sourceDomain,
      destinationDomain: quote.destinationDomain,
      tokenMessenger: quote.binding.tokenMessenger,
      usdcAddress: quote.binding.usdcAddress,
      circleBlockchain,
      walletId,
      pendingChallengeId: challengeId,
      pendingPurpose: "burn",
      burnTxHash: null,
      balanceBeforeMinor: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setUserBridgeIntent(intent);
    return NextResponse.json({
      success: true,
      state: "needs-burn",
      reference,
      challengeId,
      message: "Confirm the bridge burn in the Circle prompt.",
    });
  } catch (e: any) {
    // Typed bridge errors carry { status, code } — honor them. Never log
    // the userToken (it is not in scope here by construction).
    const status =
      typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return NextResponse.json(
      {
        success: false,
        ...(e?.code ? { code: e.code } : {}),
        error: e?.message ?? "Bridge request failed.",
      },
      { status }
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
