// src/app/api/cctp/transfer/challenge/route.ts
//
// USER_CONTROLLED bridge continue-step: after the browser executes a Circle
// challenge (approve / burn), it POSTs { reference, challengeId, userToken }
// here. The server polls the challenge → Circle tx → mined receipt and
// either advances the flow (fresh burn challenge / minting state) or
// reports a retryable non-terminal state. Idempotent — safe to retry with
// the same challengeId.
//
// Auth: FlareHQ session + consumer step-up (same 'consumer.bridge' action
// as initiation — continuing a bridge moves funds). The challengeId must
// equal the intent's pending challenge (binds the browser's execution to
// the server's intent — a foreign challengeId can never advance a bridge).
// The userToken is per-request only: passed through as X-User-Token, never
// logged, never persisted.

import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import { prisma } from "@/src/lib/prisma";
import {
  createBurnChallenge,
  getUserBridgeIntent,
  minorToDisplay,
  pollChallengeToTx,
  readArcUsdcBalanceOf,
  readSourceAllowance,
  setUserBridgeIntent,
  verifyBurnReceipt,
} from "@/lib/circle/userBridge";

export async function POST(req: NextRequest) {
  try {
    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json(
        { success: false, error: "Sign in required to bridge funds." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { reference, challengeId, userToken } = body;
    if (!reference || !challengeId) {
      return NextResponse.json(
        { success: false, error: "Missing fields: reference, challengeId." },
        { status: 400 }
      );
    }
    if (typeof userToken !== "string" || userToken.trim().length < 16) {
      return NextResponse.json(
        {
          success: false,
          code: "USER_TOKEN_REQUIRED",
          error: "Continuing the bridge needs a fresh Circle sign-in — sign in again and retry.",
        },
        { status: 401 }
      );
    }
    const token = (userToken as string).trim();

    const intent = getUserBridgeIntent(String(reference));
    if (!intent) {
      return NextResponse.json(
        {
          success: false,
          code: "UNKNOWN_REFERENCE",
          error: "No bridge found for that reference (it may have expired — start the bridge again).",
        },
        { status: 404 }
      );
    }
    // The intent's sender is fixed at initiation — a session for a
    // different wallet can never continue someone else's bridge.
    if (intent.senderAddress.toLowerCase() !== sessionAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "You do not control this bridge.", code: "BRIDGE_FORBIDDEN" },
        { status: 403 }
      );
    }
    if (!intent.pendingChallengeId || intent.pendingChallengeId !== String(challengeId)) {
      return NextResponse.json(
        {
          success: false,
          code: "CHALLENGE_MISMATCH",
          error: "That challenge does not belong to this bridge step — retry the current step.",
        },
        { status: 409 }
      );
    }
    if (intent.state === "success") {
      return NextResponse.json({ success: true, state: "success", reference: intent.reference });
    }

    const account = await (prisma as any).consumerAccount
      .findUnique({ where: { walletAddress: sessionAddress } })
      .catch(() => null);
    const stepUp = await requireConsumerStepUp(req, account, "consumer.bridge");
    if (stepUp) return stepUp;

    const progress = await pollChallengeToTx({ userToken: token, challengeId: intent.pendingChallengeId });
    if (progress.kind === "executing") {
      intent.state = "executing";
      setUserBridgeIntent(intent);
      return NextResponse.json({
        success: true,
        state: "executing",
        reference: intent.reference,
        challengeStatus: progress.challengeStatus,
        message: "Challenge still pending — approve it in the Circle prompt, then retry.",
      });
    }
    if (progress.kind === "confirming") {
      intent.state = "confirming";
      setUserBridgeIntent(intent);
      return NextResponse.json({
        success: true,
        state: "confirming",
        reference: intent.reference,
        txState: progress.txState,
        message: "Transaction submitted — waiting for on-chain confirmation, then retry.",
      });
    }
    if (progress.kind === "failed") {
      intent.state = "error";
      intent.error = progress.error ?? "Challenge failed.";
      intent.pendingChallengeId = null;
      intent.pendingPurpose = null;
      setUserBridgeIntent(intent);
      return NextResponse.json({
        success: false,
        state: "error",
        reference: intent.reference,
        error: intent.error,
      });
    }

    // progress.kind === "confirmed" — the step's tx reached Circle COMPLETE.
    if (intent.pendingPurpose === "approve") {
      // Re-read the allowance (evidence, not assertion): only a sufficient
      // allowance mints the burn challenge.
      const allowance = await readSourceAllowance({
        sourceId: intent.fromChain,
        usdc: intent.usdcAddress,
        owner: intent.senderAddress,
        spender: intent.tokenMessenger,
      });
      if (allowance < BigInt(intent.amountMinor)) {
        intent.state = "error";
        intent.error =
          "Approval confirmed but the allowance is still insufficient — retry the approval step.";
        intent.pendingChallengeId = null;
        intent.pendingPurpose = null;
        setUserBridgeIntent(intent);
        return NextResponse.json({
          success: false,
          state: "error",
          reference: intent.reference,
          error: intent.error,
        });
      }
      const { challengeId: burnChallengeId } = await createBurnChallenge({
        userToken: token,
        walletId: intent.walletId,
        circleBlockchain: intent.circleBlockchain,
        quote: {
          binding: {
            sourceId: intent.fromChain,
            usdcAddress: intent.usdcAddress,
            tokenMessenger: intent.tokenMessenger,
            sourceDomain: intent.sourceDomain,
          },
          destinationDomain: intent.destinationDomain,
          amountMinor: BigInt(intent.amountMinor),
          maxFeeMinor: BigInt(intent.maxFeeMinor),
          minFinalityThreshold: intent.minFinalityThreshold,
        },
        mintRecipient: intent.recipientAddress,
        refId: intent.reference,
      });
      intent.state = "needs-burn";
      intent.pendingChallengeId = burnChallengeId;
      intent.pendingPurpose = "burn";
      setUserBridgeIntent(intent);
      return NextResponse.json({
        success: true,
        state: "needs-burn",
        reference: intent.reference,
        challengeId: burnChallengeId,
        message: "Spending approved — confirm the bridge burn in the Circle prompt.",
      });
    }

    if (intent.pendingPurpose === "burn") {
      if (!progress.txHash) {
        intent.state = "confirming";
        setUserBridgeIntent(intent);
        return NextResponse.json({
          success: true,
          state: "confirming",
          reference: intent.reference,
          message: "Burn confirmed by Circle but the transaction hash is not indexed yet — retry shortly.",
        });
      }
      // Pattern-A burn proof: success receipt to the TokenMessenger from
      // the bridge wallet carrying the exact DepositForBurn event.
      await verifyBurnReceipt(progress.txHash, {
        sourceId: intent.fromChain,
        tokenMessenger: intent.tokenMessenger,
        sender: intent.senderAddress,
        amount: BigInt(intent.amountMinor),
        destinationDomain: intent.destinationDomain,
        mintRecipient: intent.recipientAddress,
      });
      // Baseline for the minting balance-delta: the Arc USDC balance now.
      const balanceBefore = await readArcUsdcBalanceOf(intent.recipientAddress).catch(() => null);
      intent.state = "minting";
      intent.burnTxHash = progress.txHash;
      intent.balanceBeforeMinor = balanceBefore !== null ? balanceBefore.toString() : null;
      intent.pendingChallengeId = null;
      intent.pendingPurpose = null;
      setUserBridgeIntent(intent);
      return NextResponse.json({
        success: true,
        state: "minting",
        reference: intent.reference,
        burnTxHash: progress.txHash,
        expectedMint: minorToDisplay(BigInt(intent.amountMinor) - BigInt(intent.maxFeeMinor)),
        message: "Burn verified — the Arc mint is being completed by Circle's relayer. Poll the status endpoint.",
      });
    }

    return NextResponse.json(
      { success: false, error: "Bridge step is not continuable — start the bridge again." },
      { status: 409 }
    );
  } catch (e: any) {
    const status =
      typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return NextResponse.json(
      {
        success: false,
        ...(e?.code ? { code: e.code } : {}),
        error: e?.message ?? "Bridge continue failed.",
      },
      { status }
    );
  }
}
