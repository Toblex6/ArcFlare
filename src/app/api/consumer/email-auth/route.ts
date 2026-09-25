// src/app/api/consumer/email-auth/route.ts
//
// Passwordless consumer email login (production consumer wallet model):
//
//   POST { email }        — request a sign-in code. Unauthenticated and
//                           ALWAYS returns { success: true } (unless
//                           rate-limited) so responses never reveal whether
//                           an address is registered. Works for BOTH new and
//                           returning consumers — no session required.
//   PUT  { email, code }  — verify the code. On success:
//                             - returning email -> the SAME ConsumerAccount
//                               row (CIRCLE stays CIRCLE, EXTERNAL stays
//                               EXTERNAL — never converted), and the existing
//                               consumer_token session mechanism is reused;
//                             - unknown email   -> a Circle
//                               developer-controlled SCA wallet is provisioned
//                               and a CIRCLE ConsumerAccount is created with
//                               { walletAddress, walletType: CIRCLE,
//                                 circleWalletId, email }.
//
// Reuses the existing OTP primitives (issueConsumerOtp/verifyConsumerOtp,
// SHA-256-only, single-use atomic claim, anti-enumeration) and the existing
// consumer_token session model (issueConsumerSessionToken). No Circle
// user-controlled tokens, no walletSetId.
//
// Wallet-creation safety (idempotency): two simultaneous successful
// verifications for the same new consumer must not provision two Circle
// wallets. This holds two ways:
//   1. The OTP verify step is an atomic single-use claim (conditional
//      deleteMany — exactly one concurrent verifier wins; the loser gets
//      { ok: false } and never reaches provisioning).
//   2. The account create is guarded by the @unique email constraint: on a
//      P2002 race the loser re-reads the winner's row and returns its
//      session (its own freshly provisioned Circle wallet is orphaned —
//      unfunded and unreferenced — rather than double-issuing).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { checkRateLimit } from "@/src/lib/ratelimit";
import { issueConsumerSessionToken } from "@/src/lib/auth/consumerSession";
import {
  issueConsumerOtp,
  normalizeEmail,
  verifyConsumerOtp,
} from "@/src/lib/auth/consumerOtp";
import { resolveConsumerWallet } from "@/src/lib/auth/consumerWallet";
import { createAccountWallet } from "@/src/lib/circle/client";
import { sendConsumerOtpEmail } from "@/src/lib/email";

function genericOk() {
  return NextResponse.json({ success: true });
}

function issueSessionCookie(account: {
  id: string;
  walletAddress: string;
  walletType?: string | null;
  circleWalletId?: string | null;
  email?: string | null;
  sessionVersion?: number | null;
}) {
  // M4: bind the token to the account's current sessionVersion.
  return issueConsumerSessionToken(account.id, account.walletAddress, account.sessionVersion ?? 0).then(
    (token) => ({ token })
  );
}

// POST /api/consumer/email-auth — request a sign-in code (anti-enumeration).
export async function POST(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);

  // Invalid shape and unknown address both get the same generic success —
  // the response must not distinguish them.
  if (email) {
    const account = await (prisma as any).consumerAccount
      .findUnique({ where: { email }, select: { id: true } })
      .catch(() => null);
    const { code } = await issueConsumerOtp({
      email,
      purpose: "EMAIL_LOGIN",
      accountId: account?.id ?? null,
    });
    try {
      await sendConsumerOtpEmail(email, code, "login");
    } catch {
      // Send failure is logged server-side; the response stays generic so
      // registration state is not revealed.
      console.error("[consumer/email-auth] failed to send sign-in email");
    }
  }
  return genericOk();
}

// PUT /api/consumer/email-auth — verify the code, resolve-or-create the
// CIRCLE wallet account, reissue the existing session.
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

  // Atomic single-use claim: exactly one concurrent verifier wins.
  const result = await verifyConsumerOtp({ email, code, purpose: "EMAIL_LOGIN" });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired code." },
      { status: 400 }
    );
  }

  // Returning user: the SAME row (and the SAME Circle wallet) — the OTP's
  // account binding is a hint only; the email lookup is authoritative, and
  // an EXTERNAL row is never converted into a Circle wallet.
  let account = await (prisma as any).consumerAccount
    .findUnique({ where: { email } })
    .catch(() => null);
  let isNewAccount = false;

  if (account) {
    await (prisma as any).consumerAccount
      .update({
        where: { id: account.id },
        data: {
          lastSeenAt: new Date(),
          // A pre-email row (wallet-first signup) that proves this address
          // now owns it as its verified recovery/login email.
          ...(account.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
        },
      })
      .catch(() => {});
    account = await (prisma as any).consumerAccount
      .findUnique({ where: { id: account.id } })
      .catch(() => account);
  } else {
    // New consumer: provision the Circle developer-controlled SCA wallet
    // (same helper the wallet-first signup path uses — backend can sign
    // for it via CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET), then bind it to
    // this email. The wallet-set name carries no PII.
    let wallet: { walletId: string; address: string };
    try {
      const created = await createAccountWallet(
        `consumer_email_${Date.now().toString(36)}`
      );
      wallet = { walletId: created.walletId, address: created.address };
    } catch (e: any) {
      console.error("[consumer/email-auth] Circle wallet creation failed:", e?.message ?? e);
      return NextResponse.json(
        { success: false, error: "Could not create your wallet right now. Try again." },
        { status: 502 }
      );
    }

    try {
      account = await (prisma as any).consumerAccount.create({
        data: {
          walletAddress: wallet.address,
          walletType: "CIRCLE",
          circleWalletId: wallet.walletId,
          email,
          emailVerifiedAt: new Date(),
          onboardingSource: "email",
        },
      });
      isNewAccount = true;
    } catch (e: any) {
      // Unique-constraint race (a simultaneous verification won): resolve
      // to the winner's row instead of issuing a second wallet.
      if (e?.code === "P2002") {
        account = await (prisma as any).consumerAccount
          .findUnique({ where: { email } })
          .catch(() => null);
        if (!account) {
          return NextResponse.json(
            { success: false, error: "Invalid or expired code." },
            { status: 400 }
          );
        }
      } else {
        throw e;
      }
    }
  }

  const wallet = resolveConsumerWallet(account);
  if (!wallet) {
    // Legacy/unknown custody (e.g. a retired USER_CONTROLLED row): the
    // email is proven but this wallet mode cannot take a session — fail
    // closed rather than guessing a custody model.
    return NextResponse.json(
      {
        success: false,
        code: "WALLET_UNSUPPORTED",
        error: "This wallet type is no longer supported for sign-in.",
      },
      { status: 403 }
    );
  }

  // Same session mechanism as every other consumer login — no new session
  // system.
  const { token } = await issueSessionCookie(account);
  const res = NextResponse.json({
    success: true,
    isNew: isNewAccount,
    account: {
      id: account.id,
      walletAddress: account.walletAddress,
      walletType: account.walletType ?? null,
      circleWalletId: account.circleWalletId ?? null,
      mode: wallet.mode,
      canServerSign: wallet.canServerSign,
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
