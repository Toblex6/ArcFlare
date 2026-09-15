// src/lib/wallet/signingModel.ts
//
// Signing model for consumer wallets — the single authority that maps a
// stored `walletType` (+ its custody bindings) to HOW transactions get
// signed. Browser+server-safe: pure, no node-only imports, no secrets.
//
// Models:
//   - 'server-signed'            CIRCLE developer-controlled wallet
//     (circleWalletId present): the FlareHQ server signs via CIRCLE_API_KEY
//     + CIRCLE_ENTITY_SECRET. Full automation (bridge, scheduled saves).
//   - 'external-eoa'             EXTERNAL bring-your-own wallet: the user
//     signs with their own provider (wagmi). FlareHQ never touches keys.
//   - 'unsupported'              anything else (null row, unknown type,
//     legacy USER_CONTROLLED rows from the retired Circle user-controlled
//     architecture, CIRCLE row missing its circleWalletId binding):
//     fail closed.
//
// The canonical consumer-facing view of this lives in
// src/lib/auth/consumerWallet.ts (resolveConsumerWallet /
// getAuthenticatedConsumer) — CIRCLE -> server-controlled signing,
// EXTERNAL -> browser/user signing. This module stays as the low-level
// pure mapping for Save/bridge UX branching.

export type SigningModel = "server-signed" | "external-eoa" | "unsupported";

export interface WalletCustodyBinding {
  walletType?: string | null;
  circleWalletId?: string | null;
}

function normalizeType(walletType: unknown): string {
  return typeof walletType === "string" ? walletType.trim().toUpperCase() : "";
}

// Pure mapping: stored custody fields -> signing model. Never throws —
// unknown shapes resolve to 'unsupported' (fail closed) rather than a
// guessed model.
export function signingModelForWallet(
  account: WalletCustodyBinding | null | undefined
): SigningModel {
  if (!account) return "unsupported";
  const t = normalizeType(account.walletType);
  if (t === "CIRCLE") {
    // A CIRCLE row is only server-signable when its Circle wallet binding
    // is present. Partial rows without circleWalletId must NOT be treated
    // as server wallets (there is nothing to sign with).
    return account.circleWalletId ? "server-signed" : "unsupported";
  }
  if (t === "EXTERNAL") return "external-eoa";
  return "unsupported";
}

// True when the FlareHQ server holds signing authority (developer-
// controlled wallets only). Anything else must never be server-signed.
export function canSignServerSide(model: SigningModel): boolean {
  return model === "server-signed";
}

// True when the wallet can participate in CCTP bridging at all:
// server-signed wallets bridge automatically. External EOAs cannot be
// bridged from by the server, and unsupported rows fail closed.
export function bridgeEnabled(model: SigningModel): boolean {
  return model === "server-signed";
}
