// src/lib/auth/consumerWallet.ts
//
// Canonical consumer wallet resolver — the single backend authority for
// "what wallet does this consumer control, and who can sign for it?"
//
// Consumer model (post user-controlled retirement):
//   CIRCLE   = Circle developer-controlled SCA. The server holds signing
//              authority (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET) and signs
//              via the bound circleWalletId. Server-controlled signing.
//   EXTERNAL = user-controlled external wallet (browser/injected/
//              WalletConnect). The browser must sign; the server never can.
//
// Anything else (null row, unknown type, legacy USER_CONTROLLED rows from
// the retired architecture) resolves to null — fail closed. Callers treat
// null as "reject the request", never as a guess.
//
// Feature contract for downstream consumer features:
//   wallet.mode === 'CIRCLE' && wallet.canServerSign  -> server signs
//   wallet.mode === 'EXTERNAL'                        -> browser/user signs
//
// There is intentionally no wallet-set binding anywhere in this model:
// Circle developer-controlled signing needs only the wallet id/address,
// and the wallet-set id is not part of the consumer design.

import type { NextRequest } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";

export type ConsumerWalletMode = "CIRCLE" | "EXTERNAL";

export interface ConsumerWallet {
  mode: ConsumerWalletMode;
  walletAddress: string;
  // Present for CIRCLE (the Circle developer-controlled wallet id the
  // server signs with). Always null for EXTERNAL.
  circleWalletId: string | null;
  // True only for CIRCLE rows with a bound circleWalletId.
  canServerSign: boolean;
}

export interface ConsumerAccountShape {
  walletAddress?: string | null;
  walletType?: string | null;
  circleWalletId?: string | null;
}

export interface AuthenticatedConsumer {
  account: any;
  wallet: ConsumerWallet;
}

// ─── Single feature signing rule ─────────────────────────────────────────────
// Every consumer money-moving feature (send / swap / bridge / save /
// scheduled) decides HOW it signs through this rule only — never through a
// scattered walletType string comparison in each route:
//
//   CIRCLE (+ circleWalletId bound)  -> the server signs (developer-
//      controlled SCA via CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET). The normal
//      authenticated consumer_token session (+ step-up PIN where enrolled)
//      is sufficient. No browser popup, no second authentication ceremony.
//   EXTERNAL                         -> the browser/user signs. The backend
//      must never pretend it can sign; unattended operations fail clearly.
//   anything else                    -> fail closed (legacy rows from the
//      retired architecture, CIRCLE rows missing their binding).
//
// There is no third signing model.

// Typed failure for the rule above. Routes map this to an explicit 4xx
// response (code + message) instead of a generic 500 — the caller learns
// WHY the operation cannot proceed and what to do instead.
export class ConsumerFeatureError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConsumerFeatureError";
    this.status = status;
    this.code = code;
  }
}

export interface ServerSigningBinding {
  /** On-chain address of the consumer's Circle SCA (the payer). */
  walletAddress: string;
  /** Circle developer-controlled wallet id the server signs with. */
  circleWalletId: string;
}

// Enforce the rule for a server-executed feature step. Returns the binding
// the server must sign with. Throws ConsumerFeatureError otherwise:
//   EXTERNAL            -> 409 EXTERNAL_REQUIRES_BROWSER_SIGNATURE (the user
//                          must sign in the browser; the server cannot).
//   CIRCLE w/o binding  -> 400 CIRCLE_WALLET_UNBOUND (fail closed with a
//                          recoverable state — the row exists but nothing can
//                          sign for it; never invent a replacement wallet).
export function requireServerSigning(
  wallet: ConsumerWallet | null | undefined
): ServerSigningBinding {
  if (!wallet) {
    throw new ConsumerFeatureError(
      403,
      "WALLET_UNSUPPORTED",
      "This wallet type is no longer supported for payments."
    );
  }
  if (wallet.mode === "EXTERNAL") {
    throw new ConsumerFeatureError(
      409,
      "EXTERNAL_REQUIRES_BROWSER_SIGNATURE",
      "This wallet is user-controlled — it must sign the transaction itself in the browser. The server cannot sign for it."
    );
  }
  if (!wallet.canServerSign || !wallet.circleWalletId) {
    throw new ConsumerFeatureError(
      400,
      "CIRCLE_WALLET_UNBOUND",
      "This FlareHQ wallet has no bound signing identity — server-controlled operations are unavailable until it is repaired. No funds moved."
    );
  }
  return { walletAddress: wallet.walletAddress, circleWalletId: wallet.circleWalletId };
}

// Pure mapping: stored ConsumerAccount row -> canonical wallet view.
// Never throws — unknown shapes resolve to null (fail closed).
export function resolveConsumerWallet(
  account: ConsumerAccountShape | null | undefined
): ConsumerWallet | null {
  const address =
    typeof account?.walletAddress === "string" ? account.walletAddress : "";
  if (!address) return null;
  const t =
    typeof account?.walletType === "string"
      ? account.walletType.trim().toUpperCase()
      : "";
  if (t === "CIRCLE") {
    const circleWalletId =
      typeof account?.circleWalletId === "string" && account.circleWalletId
        ? account.circleWalletId
        : null;
    return {
      mode: "CIRCLE",
      walletAddress: address,
      circleWalletId,
      canServerSign: circleWalletId !== null,
    };
  }
  if (t === "EXTERNAL") {
    return {
      mode: "EXTERNAL",
      walletAddress: address,
      circleWalletId: null,
      canServerSign: false,
    };
  }
  return null;
}

// Request helper: the authenticated ConsumerAccount AND its wallet mode,
// from the existing consumer_token session. Null when there is no session,
// no row, or the row's custody is not a known mode.
export async function getAuthenticatedConsumer(
  req: NextRequest
): Promise<AuthenticatedConsumer | null> {
  const sessionAddress = await resolveConsumerSession(req).catch(() => null);
  if (!sessionAddress) return null;
  const account = await (prisma as any).consumerAccount
    .findUnique({ where: { walletAddress: sessionAddress } })
    .catch(() => null);
  if (!account) return null;
  const wallet = resolveConsumerWallet(account);
  if (!wallet) return null;
  return { account, wallet };
}
