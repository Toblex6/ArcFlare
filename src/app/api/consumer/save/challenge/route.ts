// src/app/api/consumer/save/challenge/route.ts
//
// USER_CONTROLLED savings-reminder initiation (consumer Save fallback UX):
// builds the per-cycle USDC transfer challenge the browser executes via
// the Circle Web SDK (setAuthentication -> execute), then advances via
// POST /api/consumer/save/confirm. Consumer scope only — merchant
// payroll/scheduled code is untouched.
//
// Auth: FlareHQ consumer session + step-up ('consumer.save', same action
// as the automatic Save creation gate). The signing model decides the
// branch — never a raw walletType comparison: only
// 'user-controlled-challenge' wallets are issued challenges here. CIRCLE
// (server-signed) wallets keep the automatic /api/payments/scheduled path
// and are told so; anything else fails closed.

import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import { prisma } from "@/src/lib/prisma";
import { signingModelForWallet } from "@/src/lib/wallet/signingModel";
import {
  createSaveChallenge,
  newSaveIntent,
  parseSaveAmountMinor,
  resolveUserSaveWallet,
} from "@/lib/circle/userSave";

export async function POST(req: NextRequest) {
  try {
    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json(
        { success: false, error: "Sign in required to save." },
        { status: 401 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const { amount, destination, userToken } = body;

    const account = await (prisma as any).consumerAccount
      .findUnique({ where: { walletAddress: sessionAddress } })
      .catch(() => null);
    // Signing-model gate: only user-controlled-challenge wallets get a
    // reminder challenge. A CIRCLE row without walletSetId is NOT
    // server-signable and must fail closed here (never silently routed to
    // the automatic path).
    const model = signingModelForWallet(account);
    if (model !== "user-controlled-challenge") {
      if (model === "server-signed") {
        return NextResponse.json(
          {
            success: false,
            code: "USE_AUTOMATIC_SAVE",
            error:
              "This wallet saves automatically — set up the plan in the Save form and it runs on schedule.",
          },
          { status: 400 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          code: "SAVE_UNSUPPORTED_WALLET",
          error: "Saving from this wallet type is not supported yet.",
        },
        { status: 400 }
      );
    }

    const stepUp = await requireConsumerStepUp(req, account, "consumer.save");
    if (stepUp) return stepUp;

    if (typeof userToken !== "string" || userToken.trim().length < 16) {
      return NextResponse.json(
        {
          success: false,
          code: "USER_TOKEN_REQUIRED",
          error: "Saving from your FlareHQ wallet needs a fresh Circle sign-in — sign in again and retry.",
        },
        { status: 401 }
      );
    }
    const token = userToken.trim();

    let amountMinor: bigint;
    try {
      amountMinor = parseSaveAmountMinor(amount);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, code: e?.code ?? "INVALID_AMOUNT", error: e?.message ?? "Invalid amount." },
        { status: typeof e?.status === "number" ? e.status : 400 }
      );
    }

    const senderAddress = getAddress(sessionAddress);
    // Save destination defaults to the wallet itself (self-save, same as
    // the automatic Save form's payer == receiver). An explicit address is
    // accepted only as a valid 0x address — the receipt proof binds it.
    const destRaw = typeof destination === "string" && destination.trim() ? destination.trim() : senderAddress;
    if (!/^0x[0-9a-fA-F]{40}$/.test(destRaw)) {
      return NextResponse.json(
        { success: false, error: "Destination must be a valid 0x address." },
        { status: 400 }
      );
    }
    const destinationAddress = getAddress(destRaw);

    // Trust anchor: the session address must belong to THIS userToken, and
    // the Arc wallet resource must exist (fail closed otherwise).
    const { walletId } = await resolveUserSaveWallet({ userToken: token, sessionAddress: senderAddress });

    const refId = `ucsave_${Date.now().toString(36)}`;
    const built = await createSaveChallenge({
      userToken: token,
      walletId,
      destination: destinationAddress,
      amountMinor,
      refId,
    });
    const intent = newSaveIntent({
      senderAddress,
      destinationAddress,
      amountMinor,
      tokenAddress: built.tokenAddress,
      walletId,
      circleBlockchain: built.blockchain,
      pendingChallengeId: built.challengeId,
    });

    return NextResponse.json({
      success: true,
      reference: intent.reference,
      challengeId: built.challengeId,
      amount: String(amount).trim(),
      destination: destinationAddress,
      message: "Approve this savings transfer in the Circle prompt.",
    });
  } catch (e: any) {
    const status =
      typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return NextResponse.json(
      {
        success: false,
        ...(e?.code ? { code: e.code } : {}),
        error: e?.message ?? "Could not start the savings step.",
      },
      { status }
    );
  }
}
