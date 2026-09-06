// src/app/api/consumer/security/route.ts
//
// Security-status read for the consumer "Wallet security" panel (B4).
// READ-only — intentionally NOT step-up gated (it only reports booleans).
// Returns enrollment state, never secrets: no PIN, no PIN hash, no raw
// email (masked form only), no OTP material.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { checkRateLimit } from "@/src/lib/ratelimit";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 1) || "*";
  return `${head}***@${domain}`;
}

// GET /api/consumer/security — wallet security state.
export async function GET(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "session");
  if (!allowed) return response as NextResponse;

  const walletAddress = await resolveConsumerSession(req);
  if (!walletAddress) {
    return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
  }
  const account = await (prisma as any).consumerAccount.findUnique({
    where: { walletAddress },
    select: {
      walletAddress: true,
      walletType: true,
      email: true,
      emailVerifiedAt: true,
      pinHash: true,
    },
  });
  if (!account) {
    return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
  }

  const hasRecoveryEmail = !!(account.email && account.emailVerifiedAt);
  return NextResponse.json({
    success: true,
    walletCreated: true,
    walletAddress: account.walletAddress,
    walletType: account.walletType ?? null,
    hasRecoveryEmail,
    maskedEmail: hasRecoveryEmail ? maskEmail(account.email) : null,
    hasPin: !!account.pinHash,
  });
}
