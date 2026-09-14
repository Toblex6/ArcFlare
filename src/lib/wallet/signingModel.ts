// src/lib/wallet/signingModel.ts
//
// Signing model for consumer wallets — the single authority that maps a
// stored `walletType` (+ its custody bindings) to HOW transactions get
// signed. Browser+server-safe: pure, no node-only imports, no secrets.
//
// Models:
//   - 'server-signed'            CIRCLE developer-controlled wallet
//     (walletSetId present): the FlareHQ server signs via CIRCLE_API_KEY +
//     CIRCLE_ENTITY_SECRET. Full automation (bridge, scheduled saves).
//   - 'user-controlled-challenge' USER_CONTROLLED Circle wallet (SCA, owned
//     by the end user): the server orchestrates (builds calldata, creates
//     Circle challenges via REST) and the BROWSER executes each challenge
//     through @circle-fin/w3s-pw-web-sdk (setAuthentication -> execute).
//     Nothing is automatic — every signature needs the user in the loop.
//   - 'external-eoa'             EXTERNAL bring-your-own wallet: the user
//     signs with their own provider (wagmi). FlareHQ never touches keys.
//   - 'unsupported'              anything else (null row, unknown type,
//     CIRCLE row missing its walletSetId binding): fail closed.
//
// Merchant reuse: merchant flows that branch on custody should call
// signingModelForWallet() rather than comparing walletType strings — the
// string alone cannot distinguish a server-signable CIRCLE row (walletSetId
// present) from a broken one (walletSetId missing, e.g. legacy rows).

export type SigningModel =
  | "server-signed"
  | "user-controlled-challenge"
  | "external-eoa"
  | "unsupported";

export interface WalletCustodyBinding {
  walletType?: string | null;
  walletSetId?: string | null;
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
    // A CIRCLE row is only server-signable when its wallet-set binding is
    // present. Legacy/partial rows without walletSetId must NOT be treated
    // as server wallets (there is nothing to sign with).
    return account.walletSetId ? "server-signed" : "unsupported";
  }
  if (t === "USER_CONTROLLED") return "user-controlled-challenge";
  if (t === "EXTERNAL") return "external-eoa";
  return "unsupported";
}

// True when a signature requires a browser-executed Circle challenge
// (user-controlled wallets). Callers use this to demand a per-request
// userToken and to route through the challenge endpoints.
export function requiresClientChallenge(model: SigningModel): boolean {
  return model === "user-controlled-challenge";
}

// True when the FlareHQ server holds signing authority (developer-
// controlled wallets only). Anything else must never be server-signed.
export function canSignServerSide(model: SigningModel): boolean {
  return model === "server-signed";
}

// True when the wallet can participate in CCTP bridging at all:
// server-signed bridges automatically; user-controlled bridges via
// browser-executed burn challenges (destination mint needs no wallet
// signature — Circle's relayer completes it, so only the source-chain
// approve + depositForBurn need signing). External EOAs cannot be bridged
// from by the server, and unsupported rows fail closed.
export function bridgeEnabled(model: SigningModel): boolean {
  return model === "server-signed" || model === "user-controlled-challenge";
}
