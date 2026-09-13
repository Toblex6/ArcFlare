// src/lib/circle/userControlled.ts
//
// Server-side Circle USER-CONTROLLED wallet helpers (Google social login +
// email OTP onboarding for individual/consumer users).
//
// Custody model: these wallets are owned and signed by the END USER through
// Circle's Web SDK (@circle-fin/w3s-pw-web-sdk) — OAuth/OTP ceremony +
// challenge approval happen in the browser. This module NEVER sees, stores,
// or transports private keys or user key material: it only proxies the
// Circle REST API with the server's CIRCLE_API_KEY plus the per-user
// `userToken` the browser obtained from Circle itself.
//
// Endpoints (Circle user-controlled wallets REST API):
//   POST /v1/w3s/users/social/token  { deviceId }            -> device session for the SDK social flow
//   POST /v1/w3s/users/email/token   { deviceId, email }     -> device session + otpToken for the SDK email flow
//   POST /v1/w3s/user/initialize     (X-User-Token)          -> challengeId for wallet creation
//   GET  /v1/w3s/wallets              (X-User-Token)          -> authoritative wallet list for that Circle user
//   POST /v1/w3s/users/token/refresh (X-User-Token)          -> fresh userToken before expiry
//
// The browser keeps the userToken/encryptionKey in memory only (never in
// localStorage, never in a cookie). The FlareHQ consumer session
// (consumer_token JWT) is issued SEPARATELY by
// src/app/api/consumer/session/route.ts AFTER this module verifies — via a
// userToken-authenticated listWallets call — that the linked address really
// belongs to the authenticated Circle user. A client-supplied address alone
// is never trusted.
//
// Server-only: importing this module in a browser bundle throws (same rule
// as the Tower client) so CIRCLE_API_KEY can never leak client-side.

import { randomUUID } from "node:crypto";
import { getNetworkConfig } from "@/lib/config/network";

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/circle/userControlled.ts is server-only (it carries CIRCLE_API_KEY) and must never be bundled for the browser."
  );
}

export const CIRCLE_USER_CONTROLLED_ALREADY_INITIALIZED = 155106;

export interface UserControlledConfig {
  apiKey: string;
  appId: string;
  baseUrl: string;
  blockchain: string;
}

// Fail closed with an actionable message — never a silent default, never a
// leaked secret. appId identifies the Circle Console "User Controlled →
// Configurator" entry (Google Client ID + email SMTP live there, not here).
export function getUserControlledConfig(): UserControlledConfig {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "Circle user-controlled wallets are not configured: CIRCLE_API_KEY is missing."
      ),
      { status: 503, code: "CIRCLE_NOT_CONFIGURED" }
    );
  }
  const appId = process.env.CIRCLE_APP_ID;
  if (!appId) {
    throw Object.assign(
      new Error(
        "Circle user-controlled wallets are not configured: CIRCLE_APP_ID is missing. " +
          "Copy the App ID from Circle Console → Wallets → User Controlled → Configurator."
      ),
      { status: 503, code: "CIRCLE_APP_ID_MISSING" }
    );
  }
  const baseUrl = (process.env.CIRCLE_BASE_URL ?? "https://api.circle.com").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) {
    throw Object.assign(
      new Error("CIRCLE_BASE_URL must be an https URL."),
      { status: 500, code: "CIRCLE_BASE_URL_INVALID" }
    );
  }
  return { apiKey, appId, baseUrl, blockchain: getNetworkConfig().circleBlockchain };
}

export interface CircleUserWallet {
  id: string;
  address: string;
  blockchain: string;
  state?: string;
}

function circleError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

// Thin Circle REST call. Tokens are never logged. Circle error payloads are
// passed through as { status, code, message } so callers (and the
// session-link route) can branch on real Circle codes — e.g. 155106
// (user already initialized → returning user, list wallets instead).
async function circleFetch<T>(args: {
  config: UserControlledConfig;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  userToken?: string;
  label: string;
}): Promise<T> {
  const res = await fetch(`${args.config.baseUrl}${args.path}`, {
    method: args.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.config.apiKey}`,
      ...(args.userToken ? { "X-User-Token": args.userToken } : {}),
    },
    body: args.body ? JSON.stringify({ idempotencyKey: randomUUID(), ...args.body }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (data as any)?.code;
    const message =
      (data as any)?.message ?? (data as any)?.error ?? `Circle ${args.label} failed (HTTP ${res.status}).`;
    const err = circleError(
      res.status >= 500 ? 502 : res.status,
      typeof code === "number" ? `CIRCLE_${code}` : "CIRCLE_REQUEST_FAILED",
      String(message)
    );
    (err as any).circleCode = code;
    throw err;
  }
  return ((data as any)?.data ?? data) as T;
}

function assertDeviceId(deviceId: unknown): string {
  if (typeof deviceId !== "string" || deviceId.trim().length === 0 || deviceId.length > 256) {
    throw circleError(400, "INVALID_DEVICE_ID", "A valid deviceId from the Circle Web SDK is required.");
  }
  return deviceId.trim();
}

function assertUserToken(userToken: unknown): string {
  if (typeof userToken !== "string" || userToken.trim().length < 16) {
    throw circleError(401, "INVALID_USER_TOKEN", "A valid Circle userToken is required.");
  }
  return userToken.trim();
}

// ── Social (Google) login: device-bound session for the Web SDK ─────────────
export async function createSocialDeviceToken(
  deviceId: string,
  config: UserControlledConfig = getUserControlledConfig()
): Promise<{ deviceToken: string; deviceEncryptionKey: string }> {
  return circleFetch({
    config,
    method: "POST",
    path: "/v1/w3s/users/social/token",
    body: { deviceId: assertDeviceId(deviceId) },
    label: "social device token",
  });
}

// ── Email OTP login: device-bound session + otpToken for the Web SDK ────────
export async function createEmailDeviceToken(
  deviceId: string,
  email: string,
  config: UserControlledConfig = getUserControlledConfig()
): Promise<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }> {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw circleError(400, "INVALID_EMAIL", "A valid email address is required.");
  }
  return circleFetch({
    config,
    method: "POST",
    path: "/v1/w3s/users/email/token",
    body: { deviceId: assertDeviceId(deviceId), email: normalized },
    label: "email device token",
  });
}

// ── Initialize the Circle user (first wallet) → challengeId ─────────────────
// Throws with circleCode === 155106 when the user already has a wallet — the
// caller must then listWallets() instead (returning-user path).
export async function initializeUserControlledUser(
  userToken: string,
  config: UserControlledConfig = getUserControlledConfig()
): Promise<{ challengeId: string }> {
  return circleFetch({
    config,
    method: "POST",
    path: "/v1/w3s/user/initialize",
    body: { accountType: "SCA", blockchains: [config.blockchain] },
    userToken: assertUserToken(userToken),
    label: "user initialize",
  });
}

// ── Authoritative wallet list for the authenticated Circle user ─────────────
// This is the trust anchor for the FlareHQ session link: only addresses
// Circle returns here (for THIS userToken) may be linked to a
// ConsumerAccount. Never accept a client-supplied address without this check.
export async function listUserControlledWallets(
  userToken: string,
  config: UserControlledConfig = getUserControlledConfig()
): Promise<CircleUserWallet[]> {
  const data = await circleFetch<{ wallets?: Array<Record<string, unknown>> }>({
    config,
    method: "GET",
    path: "/v1/w3s/wallets",
    userToken: assertUserToken(userToken),
    label: "list wallets",
  });
  const wallets = Array.isArray(data.wallets) ? data.wallets : [];
  return wallets
    .filter((w) => typeof w?.id === "string" && typeof w?.address === "string")
    .map((w) => ({
      id: w.id as string,
      address: w.address as string,
      blockchain: typeof w.blockchain === "string" ? w.blockchain : "",
      state: typeof w.state === "string" ? w.state : undefined,
    }));
}

// Prefer the wallet on the active Arc network; fall back to any wallet only
// when no network-matching wallet exists yet (the caller decides whether an
// empty result means "complete wallet creation first").
export function selectArcWallet(
  wallets: CircleUserWallet[],
  blockchain: string = getNetworkConfig().circleBlockchain
): CircleUserWallet | null {
  if (wallets.length === 0) return null;
  const onArc = wallets.find(
    (w) => w.blockchain?.toUpperCase() === blockchain.toUpperCase()
  );
  return onArc ?? wallets[0];
}

// ── Session extension before the 14-day userToken expiry ────────────────────
// Only needed for long-lived in-browser Circle signing sessions; the FlareHQ
// consumer_token session is independent of this token.
export async function refreshUserControlledToken(
  userToken: string,
  refreshToken: string,
  config: UserControlledConfig = getUserControlledConfig()
): Promise<{ userToken: string; refreshToken: string }> {
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw circleError(400, "INVALID_REFRESH_TOKEN", "A valid Circle refreshToken is required.");
  }
  return circleFetch({
    config,
    method: "POST",
    path: "/v1/w3s/users/token/refresh",
    body: { refreshToken: refreshToken.trim() },
    userToken: assertUserToken(userToken),
    label: "token refresh",
  });
}
