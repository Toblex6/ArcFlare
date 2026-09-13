// src/components/swap/swapCopy.ts
//
// Pure, dependency-free presentation helpers for Flow Swap (consumer
// self-custody USDC↔EURC on Arc).
//
// Rules:
// - Display formatting only — never prices, never converts, never guesses.
//   Every amount shown is formatted from a server-computed exact integer.
// - Swap-leg units (what the quoter settles in) differ from canonical
//   display units on the USDC leg (WUSDC is 18-dec; EURC is 6-dec). The two
//   helpers below keep that conversion in exactly one place.
// - Never surface pool addresses, router internals, fee-tier numbers,
//   calldata, or provider names — those stay server-side.

import { formatUnits, parseUnits } from 'viem';

export type SwapSymbol = 'USDC' | 'EURC';

export const SWAP_SYMBOLS: readonly SwapSymbol[] = ['USDC', 'EURC'] as const;

/** Swap-leg decimals: WUSDC-denominated USDC leg is 18-dec, EURC is 6-dec. */
export function swapLegDecimals(symbol: SwapSymbol): number {
  return symbol === 'USDC' ? 18 : 6;
}

/** Canonical display decimals for both USDC and EURC on Arc. */
export const CANONICAL_DECIMALS = 6;

/** Format a canonical 6-dec base-unit integer for display. */
export function formatCanonical(baseUnits: string | bigint, decimals = CANONICAL_DECIMALS): string {
  try {
    return formatUnits(BigInt(baseUnits), decimals);
  } catch {
    return '—';
  }
}

/** Format a swap-leg integer (18-dec on the USDC leg, 6-dec EURC). */
export function formatSwapLeg(amountSwap: string | bigint, symbol: SwapSymbol): string {
  try {
    return formatUnits(BigInt(amountSwap), swapLegDecimals(symbol));
  } catch {
    return '—';
  }
}

/** "M:SS" countdown for quote expiry. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`;
}

/**
 * Truncate a decimal string to at most 6 decimals (no rounding-up, so the
 * result never exceeds the source balance). Used by Max: balance strings
 * from the API are floats-as-strings and can carry more than 6 decimals,
 * which would otherwise produce an amount the form itself rejects.
 */
export function truncateToSixDecimals(raw: string): string {
  const s = raw.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? '').slice(0, 6).replace(/0+$/, '');
  return frac === '' ? m[1]! : `${m[1]}.${frac}`;
}

/** Strict decimal string → canonical 6-dec base units, or null when invalid. */
export function parseAmountToBaseUnits(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  try {
    const v = parseUnits(s, CANONICAL_DECIMALS);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Validate the amount field for inline form errors (null = valid). */
export function validateSwapAmount(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null; // empty = idle, not an error
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    return 'Enter a positive number with up to 6 decimals.';
  }
  try {
    if (parseUnits(s, CANONICAL_DECIMALS) <= 0n) return 'Amount must be greater than 0.';
  } catch {
    return 'That amount could not be read — check the number and try again.';
  }
  return null;
}

export function shortHash(hash: string): string {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function shortAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Map a raw /api/swap/* failure to consumer-safe copy. The raw server
 * message (which may use venue/venue-math vocabulary) is returned
 * separately for the collapsible technical-details surface — never as the
 * headline.
 */
export function friendlySwapError(raw: string | null | undefined): {
  headline: string;
  raw: string | null;
} {
  const msg = (raw ?? '').trim() || 'Swap failed.';
  const lower = msg.toLowerCase();
  if (lower.includes('already consumed') || lower.includes('already-settled') || lower.includes('already settled')) {
    return { headline: 'This swap was already completed — no further action is needed.', raw: msg };
  }
  if (lower.includes('already tracked') || lower.includes('already consumed by another')) {
    return { headline: 'This transaction was already used by another swap or payment.', raw: msg };
  }
  if (lower.includes('expired')) {
    return { headline: 'This quote expired. Getting a fresh quote to continue.', raw: msg };
  }
  if (lower.includes('different wallet') || lower.includes('does not match the authenticated wallet')) {
    return { headline: 'The connected wallet does not match your signed-in wallet. Reconnect the same wallet and try again.', raw: msg };
  }
  if (lower.includes('ownership could not be verified') || lower.includes('sign in required')) {
    return { headline: 'Your session expired. Sign in again to continue.', raw: msg };
  }
  if (lower.includes('no live v3 pool') || lower.includes('cannot cover this') || lower.includes('unavailable')) {
    return { headline: 'No swap route is available for this amount right now. Try a smaller amount or try again shortly.', raw: msg };
  }
  if (lower.includes('amount must be') || lower.includes('positive number') || lower.includes('greater than 0')) {
    return { headline: 'Enter a valid amount greater than 0 (up to 6 decimals).', raw: msg };
  }
  if (lower.includes('unsupported swap token') || lower.includes('usdc and eurc only')) {
    return { headline: 'Flow Swap supports USDC and EURC only.', raw: msg };
  }
  if (lower.includes('same-token') || lower.includes('must differ')) {
    return { headline: 'Pick two different tokens to swap between.', raw: msg };
  }
  if (lower.includes('wrap') && lower.includes('required')) {
    return { headline: 'This swap needs its preparation transaction first — it was not completed. Start the swap again.', raw: msg };
  }
  if (lower.includes('unwrap') || lower.includes('receive step')) {
    return { headline: 'The final receive step could not be completed. Your swap output is safe in your wallet — try again.', raw: msg };
  }
  if (lower.includes('reverted on-chain')) {
    return { headline: 'The swap transaction reverted on-chain. No output was credited — check the explorer link for details.', raw: msg };
  }
  if (lower.includes('not found on-chain') || lower.includes('receipt not found')) {
    return { headline: 'That transaction could not be found on-chain yet. Wait a moment and verify again.', raw: msg };
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return { headline: 'Too many requests — wait a moment and try again.', raw: msg };
  }
  if (
    lower.includes('rpc') ||
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('failed to fetch') ||
    lower.includes('timeout') ||
    lower.includes('connection')
  ) {
    return { headline: 'Could not reach the swap service. Check your connection and try again.', raw: msg };
  }
  return { headline: 'Something went wrong with this swap. Please try again.', raw: msg };
}

/** Friendly copy for wallet-side (signing/broadcast) failures. */
export function friendlySwapWalletError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? '');
  const lower = raw.toLowerCase();
  if (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('rejected the request') ||
    lower.includes('request rejected') ||
    lower.includes('user cancelled') ||
    lower.includes('action rejected')
  ) {
    return 'Signature was cancelled in your wallet. No funds were moved.';
  }
  if (lower.includes('insufficient') || lower.includes('out of funds') || lower.includes('outoffunds') || lower.includes('gas required exceeds allowance')) {
    return 'Your wallet does not hold enough to complete this transaction. Top up and try again.';
  }
  if (lower.includes('timed out') || lower.includes('did not respond') || lower.includes("didn't respond")) {
    return "Your wallet didn't respond. Open your wallet app and try again.";
  }
  return 'Your wallet could not complete this step. Open your wallet app and try again.';
}
