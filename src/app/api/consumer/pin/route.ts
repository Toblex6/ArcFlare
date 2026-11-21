// src/app/api/consumer/pin/route.ts
//
// Payment-PIN lifecycle — the step-up credential (Stage 2).
//   POST { pin }     — FIRST-TIME SET (bootstrap): valid consumer session
//                      only. Rejected with 409 when a PIN already exists
//                      (use PUT to change). This is the one "session-only"
//                      bootstrap the inventory allows for a new credential.
//   PUT  { newPin, confirmPin } — CHANGE: step-up against the OLD credential — the
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
async function getPinStatus(req: NextRequest) {
  const { allowed, response } = await checkRateLimit(req, "session");
  if (!allowed) return response as NextResponse;
  const { account, error } = await loadAccount(req);
  if (error) return error;
  return NextResponse.json({ success: true, set: !!account.pinHash });
}

// POST /api/consumer/pin — first-time bootstrap (session-only).
async function enrollPin(req: NextRequest) {
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
  const enrolled = await (prisma as any).consumerAccount.updateMany({
    where: { id: account.id, pinHash: null },
    data: { pinHash, pinFailedAttempts: 0, pinLockedUntil: null },
  });
  if (enrolled.count !== 1) {
    return NextResponse.json({ success: false, error: "A payment PIN is already set. Refresh your security settings." }, { status: 409 });
  }

  return NextResponse.json({ success: true, set: true });
}

// PUT /api/consumer/pin — change (step-up against the OLD credential).
async function changePin(req: NextRequest) {
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
  if (body.confirmPin !== body.newPin) {
    return NextResponse.json({ success: false, error: "New PINs do not match." }, { status: 400 });
  }
  const oldPin = req.headers.get(CONSUMER_PIN_HEADER);
  if (oldPin === body.newPin) {
    return NextResponse.json(
      { success: false, error: "New PIN must differ from the current PIN." },
      { status: 400 }
    );
  }

  const pinHash = await hashConsumerPin(body.newPin);
  // Do not overwrite a PIN changed concurrently or clear a racing lockout.
  const changed = await (prisma as any).consumerAccount.updateMany({
    where: { id: account.id, pinHash: account.pinHash, OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: new Date() } }] },
    data: { pinHash },
  });
  if (changed.count !== 1) {
    return NextResponse.json({ success: false, error: "Security state changed. Try again after any lockout expires." }, { status: 409 });
  }

  return NextResponse.json({ success: true, changed: true });
}

// Raw ORM/provider exceptions can contain credential arguments. Never forward
// them to the response, logger, or automatic unhandled-error instrumentation.
async function privatePinResponse(action: () => Promise<NextResponse>) {
  try { return await action(); }
  catch { return NextResponse.json({ success: false, error: "Could not update PIN settings. Please try again." }, { status: 503 }); }
}

export async function GET(req: NextRequest) { return privatePinResponse(() => getPinStatus(req)); }
export async function POST(req: NextRequest) { return privatePinResponse(() => enrollPin(req)); }
export async function PUT(req: NextRequest) { return privatePinResponse(() => changePin(req)); }
