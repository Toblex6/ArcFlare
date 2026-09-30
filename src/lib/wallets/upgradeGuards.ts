// src/lib/wallets/upgradeGuards.ts
//
// Shared guards for the mainnet wallet upgrades (Steps C/E) — single
// authority for the rules both the consumer and merchant migrations obey:
//
//   - A new wallet is provisioned ONLY on a clean Circle getWallet 404.
//     Any other lookup error creates nothing ("try again").
//   - One wallet per account: DB lock + stable per-account Circle
//     idempotency keys (deterministic UUIDv4, Circle-side dedupe).
//
// Pure (no DB, no Circle, no network) — unit-testable in isolation.

import { createHash } from "node:crypto";

/** Transient-lookup signal (no wallet is ever created on this path). */
export const WALLET_CHECK_RETRY_MESSAGE = "Could not verify your wallet right now. Try again.";

/** Re-login signal when the stored wallet id is gone server-side. */
export const WALLET_NEEDS_UPDATE_MESSAGE = "Your wallet needs updating, please log in again.";

/** One-time login message shown after an upgrade (copy is exact). */
export const WALLET_UPGRADED_MESSAGE =
  "Your wallet was upgraded to Arc Mainnet. Your old address can't receive funds.";

/**
 * Clean-404 classifier for Circle getWallet failures. TRUE only when Circle
 * says the wallet does not exist (status 404 / "not found"). A 400
 * invalid-id (legacy non-UUID stored ids), 5xx, timeouts, and network
 * errors are NOT clean 404s — those must never trigger provisioning.
 */
export function isCircleClean404(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status =
    typeof anyErr.status === "number"
      ? anyErr.status
      : typeof anyErr.statusCode === "number"
        ? anyErr.statusCode
        : undefined;
  if (status === 404) return true;
  if (status === 400) return false; // malformed id (legacy rows) — never a clean 404
  const msg = typeof anyErr.message === "string" ? anyErr.message : "";
  return status !== undefined && status < 500 && /not found/i.test(msg);
}

/**
 * Stable Circle idempotency key for one account + purpose, as a UUIDv4
 * (Circle requires UUID v4). Deterministic: retries of the same migration
 * replay Circle-side instead of minting duplicates. Different purposes
 * (wallet set vs wallets) get different keys; different scopes
 * (consumer/merchant) get different namespaces.
 */
export function migrationIdempotencyKey(
  scope: "consumer" | "merchant",
  accountId: string,
  purpose: "set" | "wallets"
): string {
  const digest = createHash("sha256")
    .update(`flarehq-${scope}-migrate:${accountId}:${purpose}`)
    .digest("hex");
  // Impose UUIDv4 shape (version + variant bits) on the first 128 bits.
  const hex = `${digest.slice(0, 8)}${digest.slice(8, 12)}4${digest.slice(13, 16)}8${digest.slice(17, 20)}${digest.slice(20, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
