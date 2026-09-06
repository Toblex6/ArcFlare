// src/lib/auth/consumerOtp.ts
//
// Short-lived single-use email OTPs for consumer recovery flows
// (EMAIL_ATTACH / EMAIL_CHANGE / RECOVERY).
//
// Security properties:
//   - The raw 6-digit code is NEVER persisted (only its SHA-256 hash), NEVER
//     returned by any API response, and NEVER written to any log line. The
//     only place the raw code exists is the email body itself.
//   - Single-use: a verified row is deleted. Expired rows are treated as
//     absent. After MAX_OTP_ATTEMPTS wrong guesses the row is invalidated.
//   - Verification responses are generic ({ ok, reason: "invalid" }) so
//     callers cannot distinguish "no such OTP" from "wrong code" —
//     anti-enumeration for the unauthenticated RECOVERY path.

import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { generateVerificationCode } from "@/lib/email";

export type ConsumerOtpPurpose = "EMAIL_ATTACH" | "EMAIL_CHANGE" | "RECOVERY";

export const CONSUMER_OTP_TTL_MS = 10 * 60_000;
export const MAX_CONSUMER_OTP_ATTEMPTS = 5;

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const v = email.trim().toLowerCase();
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}

export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function hashEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Issues a new OTP row and returns the RAW code so the caller can email it.
// The caller must send the code and then drop it — never persist, log, or
// return it. Any previous unconsumed OTPs for the same email+purpose are
// invalidated first (exactly one live code per email+purpose).
export async function issueConsumerOtp(args: {
  email: string;
  purpose: ConsumerOtpPurpose;
  accountId?: string | null;
}): Promise<{ code: string; expiresAt: Date }> {
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + CONSUMER_OTP_TTL_MS);
  await (prisma as any).consumerEmailOtp.deleteMany({
    where: { email: args.email, purpose: args.purpose, consumedAt: null },
  }).catch(() => {});
  await (prisma as any).consumerEmailOtp.create({
    data: {
      accountId: args.accountId ?? null,
      email: args.email,
      codeHash: hashOtpCode(code),
      purpose: args.purpose,
      expiresAt,
    },
  });
  return { code, expiresAt };
}

export async function verifyConsumerOtp(args: {
  email: string;
  code: string;
  purpose: ConsumerOtpPurpose;
}): Promise<{ ok: true; accountId: string | null } | { ok: false }> {
  const rows = await (prisma as any).consumerEmailOtp.findMany({
    where: { email: args.email, purpose: args.purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
    take: 1,
  }).catch(() => []);
  const row = rows[0];
  if (!row || new Date(row.expiresAt).getTime() <= Date.now()) {
    if (row) {
      await (prisma as any).consumerEmailOtp.delete({ where: { id: row.id } }).catch(() => {});
    }
    return { ok: false };
  }
  if (!hashEqual(row.codeHash, hashOtpCode(args.code))) {
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= MAX_CONSUMER_OTP_ATTEMPTS) {
      await (prisma as any).consumerEmailOtp.delete({ where: { id: row.id } }).catch(() => {});
    } else {
      await (prisma as any).consumerEmailOtp.update({
        where: { id: row.id },
        data: { attempts },
      }).catch(() => {});
    }
    return { ok: false };
  }
  // Single-use: consume (delete) before returning success.
  await (prisma as any).consumerEmailOtp.delete({ where: { id: row.id } }).catch(() => {});
  return { ok: true, accountId: row.accountId ?? null };
}
