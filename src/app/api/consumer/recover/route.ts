// src/app/api/consumer/recover/route.ts
//
// Cross-device recovery (Stage 2, B1). Wallet-first creation stays
// zero-email; this is the way back in on a second device/browser.
//
//   POST { email }        — request a recovery OTP. Unauthenticated and
//                           ALWAYS returns { success: true } (unless
//                           rate-limited) so responses never reveal whether
//                           an address is registered.
//   PUT  { email, code }  — verify the OTP. On success the EXISTING session
//                           mechanism is reused: issueConsumerSessionToken()
//                           mints the same consumer_token cookie the login
//                           flow sets. No new session system is invented.
//
// One email resolves to exactly one wallet account (ConsumerAccount.email
// is @unique; only OTP-verified addresses — emailVerifiedAt non-null — are
// recoverable).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { checkRateLimit } from "@/src/lib/ratelimit";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import {
  issueConsumerOtp,
  normalizeEmail,
  verifyConsumerOtp,
} from "@/lib/auth/consumerOtp";
import { sendConsumerOtpEmail } from "@/lib/email";

function genericOk() {
  return NextResponse.json({ success: true });
}

// POST /api/consumer/recover — request a recovery code (anti-enumeration).
export async function POST(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);

  // Invalid shape and unknown address both get the same generic success —
  // the response must not distinguish them.
  if (email) {
    const account = await (prisma as any).consumerAccount.findUnique({
      where: { email },
      select: { id: true, emailVerifiedAt: true },
    }).catch(() => null);
    if (account?.emailVerifiedAt) {
      const { code } = await issueConsumerOtp({
        email,
        purpose: "RECOVERY",
        accountId: account.id,
      });
      try {
        await sendConsumerOtpEmail(email, code, "recover");
      } catch {
        // Send failure is logged server-side; the response stays generic
        // so registration state is not revealed.
        console.error("[consumer/recover] failed to send recovery email");
      }
    }
  }
  return genericOk();
}

// PUT /api/consumer/recover — verify the code, reissue the existing session.
export async function PUT(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired code." },
      { status: 400 }
    );
  }

  const result = await verifyConsumerOtp({ email, code, purpose: "RECOVERY" });
  if (!result.ok || !result.accountId) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired code." },
      { status: 400 }
    );
  }

  const account = await (prisma as any).consumerAccount.findUnique({
    where: { id: result.accountId },
  });
  if (!account || account.email?.toLowerCase() !== email || !account.emailVerifiedAt) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired code." },
      { status: 400 }
    );
  }

  await (prisma as any).consumerAccount.update({
    where: { id: account.id },
    data: { lastSeenAt: new Date() },
  }).catch(() => {});

  // Same session mechanism as the login flow — no new session system.
  const token = await issueConsumerSessionToken(account.id, account.walletAddress);
  const res = NextResponse.json({
    success: true,
    account: {
      id: account.id,
      walletAddress: account.walletAddress,
      walletType: account.walletType ?? null,
      circleWalletId: account.circleWalletId ?? null,
    },
  });
  res.cookies.set("consumer_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
