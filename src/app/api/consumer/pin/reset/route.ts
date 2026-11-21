// Session + fresh, account-bound email OTP. Never a session-only PIN reset.
// Reuses the existing OTP expiry/attempt/single-use rules and rate limiter.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveConsumerSession } from "@/lib/middleware/withConsumerAuth";
import { checkRateLimit } from "@/lib/ratelimit";
import { hashConsumerPin, isValidPinFormat } from "@/lib/auth/consumerStepUp";
import { issueConsumerOtp, verifyConsumerOtp } from "@/lib/auth/consumerOtp";
import { sendConsumerOtpEmail } from "@/lib/email";

async function loadResetAccount(req: NextRequest) {
  const walletAddress = await resolveConsumerSession(req);
  if (!walletAddress) return null;
  return (prisma as any).consumerAccount.findUnique({ where: { walletAddress } });
}

function invalidCode() {
  return NextResponse.json({ success: false, error: "Invalid or expired verification code. Request a new code." }, { status: 400 });
}

function unavailable() {
  // Never forward provider/Prisma errors: they may include secret arguments.
  return NextResponse.json({ success: false, error: "Could not complete PIN recovery. Please try again." }, { status: 503 });
}

export async function POST(req: NextRequest) {
  try {
    const limit = await checkRateLimit(req, "withdraw");
    if (!limit.allowed) return limit.response as NextResponse;
    const account = await loadResetAccount(req);
    if (!account) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    if (!account.email || !account.emailVerifiedAt || !account.pinHash) {
      return NextResponse.json({ success: false, error: "A verified recovery email and an enrolled PIN are required." }, { status: 409 });
    }
    // Destination is server-derived. Caller-supplied email/account ids are ignored.
    const { code } = await issueConsumerOtp({ email: account.email, purpose: "PIN_RESET", accountId: account.id });
    await sendConsumerOtpEmail(account.email, code, "pin-reset");
    return NextResponse.json({ success: true, sent: true });
  } catch { return unavailable(); }
}

export async function PUT(req: NextRequest) {
  try {
    const limit = await checkRateLimit(req, "withdraw");
    if (!limit.allowed) return limit.response as NextResponse;
    const account = await loadResetAccount(req);
    if (!account) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    if (!account.email || !account.emailVerifiedAt || !account.pinHash) return invalidCode();
    const body = await req.json().catch(() => ({}));
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code.trim())) return invalidCode();
    if (!isValidPinFormat(body.newPin) || body.newPin !== body.confirmPin) {
      return NextResponse.json({ success: false, error: "Enter the same new 4–6 digit PIN twice." }, { status: 400 });
    }
    const proof = await verifyConsumerOtp({ email: account.email, code: body.code.trim(), purpose: "PIN_RESET" });
    if (!proof.ok || proof.accountId !== account.id) return invalidCode();
    const pinHash = await hashConsumerPin(body.newPin);
    const changed = await (prisma as any).consumerAccount.updateMany({
      where: { id: account.id, email: account.email, emailVerifiedAt: account.emailVerifiedAt, pinHash: account.pinHash },
      // Keep failure counters/lock expiry intact, even with valid recovery proof.
      data: { pinHash },
    });
    if (changed.count !== 1) return invalidCode();
    return NextResponse.json({ success: true, changed: true });
  } catch { return unavailable(); }
}
