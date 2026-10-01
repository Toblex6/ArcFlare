// src/lib/wallets/liveness.ts
//
// SERVER-ONLY display gate for wallet addresses on mainnet.
//
// Problem: a ConsumerAccount/Merchant row can hold a circleWalletId that is
// invisible to the production Circle key (test-era wallet, Telegram-login
// account that skipped the login-time migration, any other path that never
// ran ensureMainnet*Wallet). Showing that address on the Receive page, as a
// deposit address, or as a bridge destination would direct funds at a wallet
// the server can no longer sign for or verify.
//
// Verdicts (tri-state — a timeout/5xx is NOT "stale"):
//   - live:    getWallet proved the configured Arc blockchain + state LIVE
//              (+ address match when an expected address is given). The
//              address may be shown (badge on).
//   - stale:   ONLY a clean Circle 404 (same classifier as the login-time
//              migrations) or a successful response on the WRONG chain.
//              The address is hidden; the UI shows WALLET_NEEDS_UPDATE_MESSAGE
//              and re-login runs the existing login-time migration — the
//              only repair path (never bulk, never here).
//   - unknown: timeouts, 5xx, network errors, non-LIVE state, address
//              mismatch, malformed responses. The address is ALSO hidden,
//              but the UI shows WALLET_CHECK_RETRY_MESSAGE ("try again") —
//              never "needs updating" — and NOTHING is provisioned (the
//              login-time migrations only provision on a clean 404).
//
// Off-mainnet this module never calls Circle and reports checked:false —
// callers must leave behavior unchanged and render no badge on testnet.
//
// Read-only: getWallet only. No wallet creation/transfer/sign anywhere in
// this module. Definitive (live/stale) verdicts are cached 10 minutes per
// circleWalletId (in-memory, per process); transient unknowns are never
// cached so the next display retries immediately. Cache holds verdicts
// only — never keys, never funds.
import { getCircleClient } from "@/src/lib/circle/client";
import { getArcNetworkName, getNetworkConfig } from "@/src/lib/config/network";
import {
  WALLET_CHECK_RETRY_MESSAGE,
  WALLET_NEEDS_UPDATE_MESSAGE,
  isCircleClean404,
} from "@/src/lib/wallets/upgradeGuards";

export { WALLET_CHECK_RETRY_MESSAGE, WALLET_NEEDS_UPDATE_MESSAGE };

/** Error code for transient display-gate failures (same code the send-path liveness asserts use). */
export const WALLET_CHECK_FAILED_CODE = "WALLET_CHECK_FAILED";

/** Display-gate cache TTL: 10 minutes per circleWalletId (definitive verdicts only). */
export const WALLET_LIVENESS_TTL_MS = 10 * 60 * 1000;

export type LivenessVerdict = "live" | "stale" | "unknown";

export interface WalletLiveness {
  /** "live" | "stale" | "unknown" (see module doc). */
  verdict: LivenessVerdict;
  /** True only when a mainnet getWallet check proved ARC + LIVE (+ address match). */
  live: boolean;
  /** True only for clean-404 / wrong-chain (the re-login repair path applies). */
  stale: boolean;
  /** True when a real Circle check ran (mainnet only). False on testnet. */
  checked: boolean;
  blockchain: string | null;
  state: string | null;
  address: string | null;
  walletSetId: string | null;
}

interface CacheEntry {
  expiresAt: number;
  result: WalletLiveness;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — clears the per-process liveness cache (tests only). */
export function __clearWalletLivenessCacheForTests(): void {
  cache.clear();
}

function uncheckedResult(): WalletLiveness {
  return { verdict: "unknown", live: false, stale: false, checked: false, blockchain: null, state: null, address: null, walletSetId: null };
}

function unknownResult(): WalletLiveness {
  return { verdict: "unknown", live: false, stale: false, checked: true, blockchain: null, state: null, address: null, walletSetId: null };
}

function staleResult(): WalletLiveness {
  return { verdict: "stale", live: false, stale: true, checked: true, blockchain: null, state: null, address: null, walletSetId: null };
}

/**
 * Pure classification of a successful getWallet record. Only a wrong-chain
 * record is stale — non-LIVE state, address mismatch, or a missing record
 * is "unknown" (transient-style: retry, never "needs updating").
 */
export function classifyWalletRecord(
  wallet: { blockchain?: unknown; state?: unknown; address?: unknown; walletSetId?: unknown } | null | undefined,
  expectedChain: string,
  expectedAddress?: string | null
): LivenessVerdict {
  if (!wallet || typeof wallet !== "object") return "unknown";
  if (String((wallet as any).blockchain ?? "") !== expectedChain) return "stale";
  if (String((wallet as any).state ?? "") !== "LIVE") return "unknown";
  if (
    expectedAddress &&
    String((wallet as any).address ?? "").toLowerCase() !== String(expectedAddress).toLowerCase()
  ) {
    return "unknown";
  }
  return "live";
}

/**
 * Confirm a Circle wallet is usable for display on mainnet.
 *
 * Never throws: failures resolve to stale/unknown verdicts so callers fail
 * closed (hide the address). Never provisions, moves, or signs anything —
 * provisioning lives only in the login-time migrations (clean-404-gated).
 */
export async function checkCircleWalletLiveness(
  circleWalletId: string | null | undefined,
  expectedAddress?: string | null
): Promise<WalletLiveness> {
  // Off-mainnet: no check, no behavior change, no badge.
  if (getArcNetworkName() !== "mainnet") return uncheckedResult();
  if (!circleWalletId || typeof circleWalletId !== "string") return unknownResult();

  const now = Date.now();
  const hit = cache.get(circleWalletId);
  if (hit && hit.expiresAt > now) return hit.result;

  let result: WalletLiveness;
  try {
    const res: any = await getCircleClient().getWallet({ id: circleWalletId });
    const w = res?.data?.wallet;
    const verdict = classifyWalletRecord(w, getNetworkConfig().circleBlockchain, expectedAddress);
    result = {
      verdict,
      live: verdict === "live",
      stale: verdict === "stale",
      checked: true,
      blockchain: typeof w?.blockchain === "string" ? w.blockchain : null,
      state: typeof w?.state === "string" ? w.state : null,
      address: typeof w?.address === "string" ? w.address : null,
      walletSetId: typeof w?.walletSetId === "string" ? w.walletSetId : null,
    };
  } catch (err) {
    // Clean 404 (same classifier as the migrations) is the ONLY error that
    // counts as stale. Timeouts, 5xx, network errors: unknown (retry).
    result = isCircleClean404(err) ? staleResult() : unknownResult();
  }
  // Cache definitive verdicts only — a transient unknown must retry on the
  // next display instead of withholding the address for 10 minutes.
  if (result.verdict !== "unknown") {
    cache.set(circleWalletId, { expiresAt: now + WALLET_LIVENESS_TTL_MS, result });
  }
  return result;
}
