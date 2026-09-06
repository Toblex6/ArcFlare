// src/lib/auth/consumerStepUp.ts
//
// Canonical consumer step-up gate (Stage 2: wallet security).
//
// ONE helper only — routes never check PINs themselves, and no second
// session/authentication system is introduced here. The existing
// consumer_token session (resolveConsumerSession) is verified FIRST; the
// step-up PIN is verified SECOND. A valid session alone is NOT sufficient
// for a protected action once a PIN is enrolled.
//
// Transport: the PIN travels in the `x-consumer-pin` header only — never in
// a JWT/session payload, never in a query string, never echoed in any
// response, never written to any log. Attempt rate-limiting reuses the
// existing checkRateLimit helper; per-account lockout/backoff lives on the
// ConsumerAccount row (pinFailedAttempts / pinLockedUntil).
//
// Bootstrap grace: accounts with no PIN enrolled (pinHash == null) pass
// step-up untouched, so the zero-friction wallet-creation flow and all
// pre-enrollment behavior are unchanged. The consumer UI nudges enrollment
// (security panel) instead.

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { resolveConsumerSession } from "@/lib/middleware/withConsumerAuth";
import { checkRateLimit } from "@/lib/ratelimit";

// ── Constants ──────────────────────────────────────────────────────────────
export const CONSUMER_PIN_HEADER = "x-consumer-pin";
export const MAX_CONSUMER_PIN_ATTEMPTS = 5;
export const CONSUMER_PIN_LOCK_MS = 15 * 60_000;
const BCRYPT_COST = 12; // same cost as merchant password hashes

export type ConsumerStepUpAction =
  | "consumer.send"
  | "consumer.request"
  | "consumer.save"
  | "consumer.bridge"
  | "consumer.withdraw"
  | "consumer.job-fund"
  | "consumer.escrow-act"
  | "consumer.wallet-bind"
  | "consumer.treasury"
  | "consumer.agent-pay"
  | "consumer.pin-change"
  | "consumer.email-change";

export interface ConsumerStepUpAccount {
  id: string;
  walletAddress: string;
  walletType?: string | null;
  circleWalletId?: string | null;
  pinHash?: string | null;
  pinFailedAttempts?: number | null;
  pinLockedUntil?: Date | string | null;
}

// ── PIN format / hashing (single implementation) ───────────────────────────
export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,6}$/.test(pin);
}

export async function hashConsumerPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_COST);
}

// ── Core credential check (shared by the HTTP helper and the Telegram ─────
// bot adapter — one implementation, two thin callers, never scattered).
// Returns a plain result; the callers map it to HTTP responses / bot text.
// The candidate secret is never logged, never thrown, never returned.
export async function checkConsumerPin(
  accountId: string,
  candidate: string
): Promise<{ ok: true } | { ok: false; locked: boolean; remaining: number }> {
  const record = await (prisma as any).consumerAccount.findUnique({
    where: { id: accountId },
    select: { id: true, pinHash: true, pinFailedAttempts: true, pinLockedUntil: true },
  });
  if (!record?.pinHash) {
    // No PIN enrolled — nothing to check against. Callers treat this as
    // "step-up not applicable" (bootstrap grace), never as success-with-PIN.
    return { ok: false, locked: false, remaining: MAX_CONSUMER_PIN_ATTEMPTS };
  }
  if (record.pinLockedUntil && new Date(record.pinLockedUntil).getTime() > Date.now()) {
    return { ok: false, locked: true, remaining: 0 };
  }
  const match = await bcrypt.compare(candidate, record.pinHash).catch(() => false);
  if (match) {
    await (prisma as any).consumerAccount.update({
      where: { id: accountId },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    }).catch(() => {});
    return { ok: true };
  }
  const attempts = (record.pinFailedAttempts ?? 0) + 1;
  const locked = attempts >= MAX_CONSUMER_PIN_ATTEMPTS;
  await (prisma as any).consumerAccount.update({
    where: { id: accountId },
    data: {
      pinFailedAttempts: attempts,
      pinLockedUntil: locked ? new Date(Date.now() + CONSUMER_PIN_LOCK_MS) : undefined,
    },
  }).catch(() => {});
  return { ok: false, locked, remaining: Math.max(0, MAX_CONSUMER_PIN_ATTEMPTS - attempts) };
}

// Non-HTTP adapter for the Telegram bot (the only non-HTTP consumer entry
// point). Same credential, same counters, same lockout as the HTTP helper —
// the bot passes the PIN the user typed after /confirm. No IP rate-limit
// here (no HTTP request exists); per-account lockout still applies.
export async function verifyConsumerPinForBot(
  accountId: string,
  candidate: string | undefined | null
): Promise<{ ok: true } | { ok: false; locked: boolean; remaining: number }> {
  if (!candidate || !isValidPinFormat(candidate)) {
    // Count a malformed attempt the same as a wrong one so PIN-oracle
    // probing via the bot cannot distinguish "no PIN set" from "wrong PIN".
    const record = await (prisma as any).consumerAccount.findUnique({
      where: { id: accountId },
      select: { id: true, pinHash: true },
    }).catch(() => null);
    if (!record?.pinHash) return { ok: false, locked: false, remaining: MAX_CONSUMER_PIN_ATTEMPTS };
    return checkConsumerPin(accountId, "0000-invalid");
  }
  return checkConsumerPin(accountId, candidate);
}

// ── Per-actor convenience wrapper ──────────────────────────────────────────
// Routes that already resolved an ownership actor via
// verifyCallerControlsAddress call this in one line. Non-consumer actors
// (merchant / agent / internal) pass through untouched — their own auth
// already governed them. Consumer actors get the full step-up gate.
//
//   const stepUp = await requireConsumerStepUpForActor(req, actor, "consumer.send");
//   if (stepUp) return stepUp;
export async function requireConsumerStepUpForActor(
  req: NextRequest,
  actor: { type: string; id: string } | null | undefined,
  action: ConsumerStepUpAction
): Promise<NextResponse | null> {
  if (!actor || actor.type !== "consumer") return null;
  const account = await (prisma as any).consumerAccount
    .findUnique({ where: { id: actor.id } })
    .catch(() => null);
  return requireConsumerStepUp(req, account, action);
}

// ── Canonical gate ─────────────────────────────────────────────────────────
// Returns null when the caller may proceed; returns a NextResponse
// (401/403/423/429) that the route must return immediately otherwise.
//
//   const stepUp = await requireConsumerStepUp(req, account, "consumer.send");
//   if (stepUp) return stepUp;
//
// account must be the ConsumerAccount row (or equivalent shape) for the
// wallet being debited / the setting being changed. The helper re-reads the
// fresh row by id so stale lockout counters can never bypass a lock.
export async function requireConsumerStepUp(
  req: NextRequest,
  account: ConsumerStepUpAccount | null | undefined,
  _action: ConsumerStepUpAction
): Promise<NextResponse | null> {
  // 1. The EXISTING consumer session first — in front of, never instead of.
  const sessionWallet = await resolveConsumerSession(req).catch(() => null);
  if (!sessionWallet) {
    return NextResponse.json(
      { success: false, error: "Sign in required.", code: "STEP_UP_NO_SESSION" },
      { status: 401 }
    );
  }
  if (!account || account.walletAddress?.toLowerCase() !== sessionWallet.toLowerCase()) {
    return NextResponse.json(
      { success: false, error: "You do not control this wallet.", code: "STEP_UP_FORBIDDEN" },
      { status: 403 }
    );
  }

  // Fresh row: lockout counters must be current, and enrollment state must
  // be authoritative (a cached "no PIN" must never skip an enrolled check).
  const fresh = await (prisma as any).consumerAccount.findUnique({
    where: { id: account.id },
    select: {
      id: true,
      walletAddress: true,
      walletType: true,
      circleWalletId: true,
      pinHash: true,
      pinFailedAttempts: true,
      pinLockedUntil: true,
    },
  }).catch(() => null);
  if (!fresh || fresh.walletAddress?.toLowerCase() !== sessionWallet.toLowerCase()) {
    return NextResponse.json(
      { success: false, error: "You do not control this wallet.", code: "STEP_UP_FORBIDDEN" },
      { status: 403 }
    );
  }

  // 2. Bootstrap grace — step-up not enrolled: proceed unchanged.
  if (!fresh.pinHash) return null;

  // 3. Attempt rate-limit via the EXISTING limiter (no second limiter).
  const { allowed, response } = await checkRateLimit(req, "withdraw");
  if (!allowed) return response as NextResponse;

  // 4. Lockout after repeated failures.
  if (fresh.pinLockedUntil && new Date(fresh.pinLockedUntil).getTime() > Date.now()) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many wrong attempts. Try again later.",
        code: "STEP_UP_LOCKED",
        retryAfterSeconds: Math.ceil(
          (new Date(fresh.pinLockedUntil).getTime() - Date.now()) / 1000
        ),
      },
      { status: 423 }
    );
  }

  // 5. The step-up credential — header only, never logged, never echoed.
  const candidate = req.headers.get(CONSUMER_PIN_HEADER);
  if (!candidate) {
    return NextResponse.json(
      {
        success: false,
        error: "This action needs your payment PIN.",
        code: "STEP_UP_REQUIRED",
      },
      { status: 403 }
    );
  }
  const result = await checkConsumerPin(fresh.id, candidate);
  if (result.ok) return null;
  if (result.locked) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many wrong attempts. Try again later.",
        code: "STEP_UP_LOCKED",
      },
      { status: 423 }
    );
  }
  return NextResponse.json(
    {
      success: false,
      error: "Wrong payment PIN.",
      code: "STEP_UP_FAILED",
      remainingAttempts: result.remaining,
    },
    { status: 403 }
  );
}
