// src/lib/config/platformDefaults.ts
//
// Single authority for the platform-default payer/merchant identities used by
// the settle / scheduled / nano money paths.
//
// TESTNET pins below are the exact legacy values (byte-identical testnet
// behavior). On mainnet every value MUST be supplied explicitly and resolution
// FAILS CLOSED (throws) instead of silently debiting/crediting a testnet
// identity — the class of bug behind the C1 drain. Resolvers are lazy (called
// per request, never at import) so importing this module never throws; only
// actual mainnet use without configuration does.

import { getNetworkConfig } from "@/lib/config/network";

// ─── Testnet pins (do not change; mainnet never inherits these) ─────────────
/** Platform-default Circle payer wallet id (testnet). */
export const TESTNET_PLATFORM_PAYER_WALLET_ID =
  "58ab0223-cad0-5128-896e-a88d6f217b43";
/** Platform-default merchant SCA credited for legacy/test payments (testnet). */
export const TESTNET_PLATFORM_MERCHANT_SCA =
  "0x902C565bE31c146a79350387C1f77d6896814B58";
/** Platform shared default payer SCA for nano/scheduled flows (testnet). */
export const TESTNET_PLATFORM_PAYER_SCA =
  "0x7a8214dad7630a7a39054e0121acdbc7a65821c9";

function isMainnetSelected(): boolean {
  try {
    return getNetworkConfig().name === "mainnet";
  } catch {
    // getNetworkConfig itself throws on mainnet-with-missing-config — which
    // already means "do not use testnet values". Treat as mainnet so the
    // resolvers below throw fail-closed instead of returning testnet pins.
    return (process.env.ARC_NETWORK ?? "").trim().toLowerCase() === "mainnet";
  }
}

/** Explicit platform-default payer Circle wallet id. Throws on mainnet without config. */
export function resolvePlatformPayerWalletId(): string {
  const explicit = (process.env.PLATFORM_PAYER_WALLET_ID ?? "").trim();
  if (explicit) return explicit;
  if (isMainnetSelected()) {
    throw new Error(
      "PLATFORM_PAYER_WALLET_ID is required on mainnet — refusing to debit the testnet platform-default wallet."
    );
  }
  return TESTNET_PLATFORM_PAYER_WALLET_ID;
}

/** Explicit platform-default merchant SCA. Throws on mainnet without config. */
export function resolvePlatformMerchantSca(): string {
  const explicit = (process.env.MERCHANT_SCA_ADDRESS ?? "").trim();
  if (explicit) return explicit;
  if (isMainnetSelected()) {
    throw new Error(
      "MERCHANT_SCA_ADDRESS is required on mainnet — refusing to credit the testnet platform-default merchant."
    );
  }
  return TESTNET_PLATFORM_MERCHANT_SCA;
}

/**
 * Explicit platform shared default payer SCA (nano/scheduled identity check).
 * Throws on mainnet without config.
 */
export function resolvePlatformPayerSca(): string {
  const explicit = (process.env.PLATFORM_PAYER_SCA ?? "").trim();
  if (explicit) return explicit;
  if (isMainnetSelected()) {
    throw new Error(
      "PLATFORM_PAYER_SCA is required on mainnet — refusing to match the testnet platform-default payer identity."
    );
  }
  return TESTNET_PLATFORM_PAYER_SCA;
}
