// src/app/api/consumer/save/confirm/route.ts
//
// USER_CONTROLLED savings-reminder continue-step: after the browser
// executes the per-cycle transfer challenge, it POSTs
// { reference, challengeId, userToken } here. The server polls the
// challenge → Circle tx → mined receipt (exact Transfer-event proof) and
// reports success. Idempotent — safe to retry with the same challengeId.
//
// Auth: FlareHQ consumer session + step-up ('consumer.save' — confirming a
// reminder moves funds). The challengeId must equal the intent's pending
// challenge (a foreign challengeId can never advance a save). The
// userToken is per-request only: passed through as X-User-Token, never
// logged, never persisted. Consumer scope only.

import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import { prisma } from "@/src/lib/prisma";
import { explorerTxUrl } from "@/lib/config/network";
import {
  clearUserSaveIntent,
  confirmSaveChallenge,
  getUserSaveIntent,
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
          error: "Confirming the savings step needs a fresh Circle sign-in — sign in again and retry.",
        },
        { status: 401 }
      );
    }
    const token = (userToken as string).trim();

    const intent = getUserSaveIntent(String(reference));
    if (!intent) {
      return NextResponse.json(
        {
          success: false,
          code: "UNKNOWN_REFERENCE",
          error: "No savings step found for that reference (it may have expired — start the step again).",
        },
        { status: 404 }
      );
    }
    // The intent's sender is fixed at initiation — a session for a
    // different wallet can never confirm someone else's savings step.
    if (intent.senderAddress.toLowerCase() !== sessionAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "You do not control this savings step.", code: "SAVE_FORBIDDEN" },
        { status: 403 }
      );
    }

    const account = await (prisma as any).consumerAccount
      .findUnique({ where: { walletAddress: sessionAddress } })
      .catch(() => null);
    const stepUp = await requireConsumerStepUp(req, account, "consumer.save");
    if (stepUp) return stepUp;

    try {
      const { txHash } = await confirmSaveChallenge({
        userToken: token,
        intent,
        challengeId: String(challengeId),
      });
      clearUserSaveIntent(intent.reference);
      return NextResponse.json({
        success: true,
        reference: intent.reference,
        txHash,
        explorerUrl: explorerTxUrl(txHash),
        message: "Savings transfer confirmed on-chain.",
      });
    } catch (e: any) {
      // Retryable non-terminal states ride as typed 409s so the browser
      // keeps polling the same challengeId; terminal failures clear the
      // binding so the cycle can restart cleanly.
      const code = String(e?.code ?? "");
      if (code === "CHALLENGE_FAILED" || code === "SAVE_REVERTED" || code === "SAVE_EVENT_MISMATCH") {
        clearUserSaveIntent(intent.reference);
      }
      const status =
        typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
      return NextResponse.json(
        { success: false, ...(code ? { code } : {}), error: e?.message ?? "Savings confirm failed." },
        { status }
      );
    }
  } catch (e: any) {
    const status =
      typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    return NextResponse.json(
      {
        success: false,
        ...(e?.code ? { code: e.code } : {}),
        error: e?.message ?? "Savings confirm failed.",
      },
      { status }
    );
  }
}
