// src/app/api/consumer/pin/route.ts
//
// Payment-PIN lifecycle — the step-up credential (Stage 2).
//   POST { pin }     — FIRST-TIME SET (bootstrap): valid consumer session
//                      only. Rejected with 409 when a PIN already exists
//                      (use PUT to change). This is the one "session-only"
//                      bootstrap the inventory allows for a new credential.
//   PUT  { newPin }  — CHANGE: step-up against the OLD credential — the
//                      canonical requireConsumerStepUp helper verifies the old
//                      PIN from the x-consumer-pin header before the new hash
//                      is stored. The PIN-change route itself calls the helper.
//   GET              — status { set: boolean } for the security panel.
//
// The PIN is 4–6 digits, bcrypt-hashed (cost 12, same as merchant
// passwords), never stored in plaintext, never placed in the JWT/session,
// and never returned by any endpoint here.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { checkRateLimit } from "@/src/lib/ratelimit";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import {
  CONSUMER_PIN_HEADER,
  hashConsumerPin,
  isValidPinFormat,
  requireConsumerStepUp,
} from "@/lib/auth/consumerStepUp";

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

// GET /api/consumer/pin — enrollment status only (booleans, never secrets).
export async function GET(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "session");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;
  return NextResponse.json({ success: true, set: !!account.pinHash });
}

// POST /api/consumer/pin — first-time bootstrap (session-only).
export async function POST(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;

  if (account.pinHash) {
    return NextResponse.json(
      { success: false, error: "A payment PIN is already set. Use PUT to change it." },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => ({}));
  if (!isValidPinFormat(body?.pin)) {
    return NextResponse.json(
      { success: false, error: "PIN must be 4–6 digits." },
      { status: 400 }
    );
  }

  const pinHash = await hashConsumerPin(body.pin);
  await (prisma as any).consumerAccount.update({
    where: { id: account.id },
    data: { pinHash, pinFailedAttempts: 0, pinLockedUntil: null },
  });

  return NextResponse.json({ success: true, set: true });
}

// PUT /api/consumer/pin — change (step-up against the OLD credential).
export async function PUT(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;

  if (!account.pinHash) {
    return NextResponse.json(
      { success: false, error: "No payment PIN is set yet. Use POST to set one." },
      { status: 409 }
    );
  }

  // Canonical helper verifies the OLD PIN from the x-consumer-pin header.
  const stepUp = await requireConsumerStepUp(req, account, "consumer.pin-change");
  if (stepUp) return stepUp;

  const body = await req.json().catch(() => ({}));
  if (!isValidPinFormat(body?.newPin)) {
    return NextResponse.json(
      { success: false, error: "New PIN must be 4–6 digits." },
      { status: 400 }
    );
  }
  const oldPin = req.headers.get(CONSUMER_PIN_HEADER);
  if (oldPin === body.newPin) {
    return NextResponse.json(
      { success: false, error: "New PIN must differ from the current PIN." },
      { status: 400 }
    );
  }

  const pinHash = await hashConsumerPin(body.newPin);
  await (prisma as any).consumerAccount.update({
    where: { id: account.id },
    data: { pinHash, pinFailedAttempts: 0, pinLockedUntil: null },
  });

  return NextResponse.json({ success: true, changed: true });
}
