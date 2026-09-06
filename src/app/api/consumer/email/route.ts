// src/app/api/consumer/email/route.ts
//
// Recovery-email attach / change (Stage 2, B1).
//   POST { email }        — request an OTP. First-time ATTACH is
//                           session-only (bootstrap); CHANGE to an existing
//                           address goes through the canonical step-up helper
//                           against the old credential first.
//   PUT  { email, code }  — verify the OTP and store the address. The CHANGE
//                           write re-verifies step-up here (this is the actual
//                           state change). The address is stored only after a
//                           valid OTP, with emailVerifiedAt set.
//   GET                   — status { emailSet, maskedEmail } for the UI.
//
// Anti-enumeration: responses never reveal whether an address is registered
// elsewhere. If the requested address is already attached to a DIFFERENT
// account, the request still returns success but no code is sent.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { checkRateLimit } from "@/src/lib/ratelimit";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import {
  issueConsumerOtp,
  normalizeEmail,
  verifyConsumerOtp,
  type ConsumerOtpPurpose,
} from "@/lib/auth/consumerOtp";
import { sendConsumerOtpEmail } from "@/lib/email";

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 1) || "*";
  return `${head}***@${domain}`;
}

async function loadAccount(req: NextRequest) {
  const walletAddress = await resolveConsumerSession(req);
  if (!walletAddress) return { error: unauthorized() };
  const account = await (prisma as any).consumerAccount.findUnique({
    where: { walletAddress },
  });
  if (!account) return { error: unauthorized() };
  return { account };
}

function unauthorized() {
  return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
}

// Generic success — identical whether a code was actually sent or the
// address is unavailable, so callers learn nothing about other accounts.
function genericSent() {
  return NextResponse.json({ success: true, sent: true });
}

// GET /api/consumer/email — masked status only.
export async function GET(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "session");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;
  if (!account.email) return NextResponse.json({ success: true, emailSet: false });
  return NextResponse.json({
    success: true,
    emailSet: true,
    maskedEmail: maskEmail(account.email),
    verified: !!account.emailVerifiedAt,
  });
}

// POST /api/consumer/email — request an OTP for attach (bootstrap) or change (step-up).
export async function POST(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json(
      { success: false, error: "A valid email address is required." },
      { status: 400 }
    );
  }

  const isChange = !!account.email;
  const purpose: ConsumerOtpPurpose = isChange ? "EMAIL_CHANGE" : "EMAIL_ATTACH";

  if (isChange) {
    if (email === account.email.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "This email is already attached to your wallet." },
        { status: 400 }
      );
    }
    // Step-up against the OLD credential before a new address can proceed.
    const stepUp = await requireConsumerStepUp(req, account, "consumer.email-change");
    if (stepUp) return stepUp;
  }

  // Already attached elsewhere → generic success, no code sent.
  const taken = await (prisma as any).consumerAccount.findUnique({
    where: { email },
    select: { id: true },
  }).catch(() => null);
  if (taken && taken.id !== account.id) return genericSent();

  const { code } = await issueConsumerOtp({ email, purpose, accountId: account.id });
  try {
    await sendConsumerOtpEmail(email, code, isChange ? "change" : "attach");
  } catch {
    return NextResponse.json(
      { success: false, error: "Could not send a code right now. Try again." },
      { status: 500 }
    );
  }
  return genericSent();
}

// PUT /api/consumer/email — verify the OTP and store the address.
export async function PUT(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired code." },
      { status: 400 }
    );
  }

  const isChange = !!account.email;
  const purpose: ConsumerOtpPurpose = isChange ? "EMAIL_CHANGE" : "EMAIL_ATTACH";

  if (isChange) {
    // The write itself re-verifies step-up — a POST-time check alone is not
    // sufficient for changing an existing recovery address.
    const stepUp = await requireConsumerStepUp(req, account, "consumer.email-change");
    if (stepUp) return stepUp;
  }

  const result = await verifyConsumerOtp({ email, code, purpose });
  if (!result.ok || result.accountId !== account.id) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired code." },
      { status: 400 }
    );
  }

  try {
    await (prisma as any).consumerAccount.update({
      where: { id: account.id },
      data: { email, emailVerifiedAt: new Date() },
    });
  } catch (e: any) {
    // Concurrent attach elsewhere (unique constraint) — stay generic.
    return NextResponse.json(
      { success: false, error: "Could not attach this email." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, emailSet: true, maskedEmail: maskEmail(email) });
}
