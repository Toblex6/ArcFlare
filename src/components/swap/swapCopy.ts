// src/components/swap/swapCopy.ts
//
// Pure, dependency-free presentation helpers for Flow Swap (consumer
// self-custody USDC↔EURC↔cirBTC on Arc).
//
// Rules:
// - Display formatting only — never prices, never converts, never guesses.
//   Every amount shown is formatted from a server-computed exact integer.
// - Precision is PER TOKEN, resolved from the canonical registry
//   (supportedTokens.ts — the single token table): USDC/EURC 6 decimals,
//   cirBTC 8 decimals. Nothing here hardcodes 6 globally.
// - Swap-leg units (what the quoter settles in) equal canonical units on
//   every leg except USDC (WUSDC is 18-dec; EURC is 6-dec; cirBTC is 8-dec).
// - Never surface pool addresses, router internals, fee-tier numbers, or
//   calldata — those stay server-side. Execution/rate-discovery VENUE labels
//   (e.g. UnitFlow, Tower) are the deliberate exception: FlowSwapView shows
//   them as secondary provenance ("who executed / who compared") derived
//   from the backend quote response, never hardcoded.

import { formatUnits, parseUnits } from 'viem';
import { getTokenBySymbol } from '@/lib/tokens/supportedTokens';

export type SwapSymbol = 'USDC' | 'EURC' | 'CIRBTC';

export const SWAP_SYMBOLS: readonly SwapSymbol[] = ['USDC', 'EURC', 'CIRBTC'] as const;

/** On-chain display label: cirBTC keeps its canonical camelCase brand. */
export function displaySymbol(symbol: SwapSymbol): string {
  return symbol === 'CIRBTC' ? 'cirBTC' : symbol;
}

/** Canonical display decimals for a swap symbol (6 for USDC/EURC, 8 for cirBTC). */
export function canonicalDecimals(symbol: SwapSymbol): number {
  return getTokenBySymbol(symbol).decimals;
}

/** Swap-leg decimals: WUSDC-denominated USDC leg is 18-dec, EURC 6-dec, cirBTC 8-dec. */
export function swapLegDecimals(symbol: SwapSymbol): number {
  return symbol === 'USDC' ? 18 : canonicalDecimals(symbol);
}

/** Canonical display decimals for the USDC/EURC stable pair (legacy default). */
export const CANONICAL_DECIMALS = 6;

/** Format a canonical base-unit integer for display (token-native precision). */
export function formatCanonical(baseUnits: string | bigint, decimals = CANONICAL_DECIMALS): string {
  try {
    return formatUnits(BigInt(baseUnits), decimals);
  } catch {
    return '—';
  }
}

/** Format a canonical base-unit integer for a specific swap symbol. */
export function formatCanonicalFor(baseUnits: string | bigint, symbol: SwapSymbol): string {
  return formatCanonical(baseUnits, canonicalDecimals(symbol));
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
 * Truncate a decimal string to at most `decimals` places (no rounding-up, so
 * the result never exceeds the source balance). Used by Max: balance strings
 * from the API are floats-as-strings and can carry more precision than the
 * field accepts, which would otherwise produce an amount the form rejects.
 */
export function truncateToDecimals(raw: string, decimals: number): string {
  const s = raw.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? '').slice(0, decimals).replace(/0+$/, '');
  return frac === '' ? m[1]! : `${m[1]}.${frac}`;
}

/**
 * Truncate a decimal string to at most 6 decimals (legacy stable-pair
 * default — prefer truncateToDecimals with the token's decimals).
 */
export function truncateToSixDecimals(raw: string): string {
  return truncateToDecimals(raw, 6);
}

/**
 * Normalize a float-as-string balance from the API into an exact decimal
 * string with at most `decimals` places (floor — never overstates). Handles
 * exponent-form floats ("1e-8") that plain decimal parsing would reject.
 */
export function normalizeBalanceString(raw: string, decimals: number): string | null {
  const n = Number((raw ?? '').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  const floored = Math.floor(n * 10 ** decimals) / 10 ** decimals;
  // toFixed first: String(1e-8) is exponent-form ("1e-8"), which no decimal
  // parser accepts — toFixed always yields plain decimal notation.
  return truncateToDecimals(floored.toFixed(decimals), decimals) || '0';
}

/** Strict decimal string → canonical base units for a symbol, or null when invalid. */
export function parseAmountToBaseUnits(raw: string, symbol: SwapSymbol = 'USDC'): bigint | null {
  const decimals = canonicalDecimals(symbol);
  const s = raw.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Validate the amount field for inline form errors (null = valid). */
export function validateSwapAmount(raw: string, symbol: SwapSymbol = 'USDC'): string | null {
  const decimals = canonicalDecimals(symbol);
  const s = raw.trim();
  if (s === '') return null; // empty = idle, not an error
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) {
    return `Enter a positive number with up to ${decimals} decimals.`;
  }
  try {
    if (parseUnits(s, decimals) <= 0n) return 'Amount must be greater than 0.';
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
 * Customer-facing label for a swap venue id returned by the backend quote
 * response. Unknown ids fall back to the raw id (never blank, never a
 * hardcoded claim about a venue the backend did not name).
 */
export function friendlyVenueLabel(venueId: string | null | undefined): string {
  const v = (venueId ?? '').trim().toLowerCase();
  if (v === 'unitflow-v3' || v === 'unitflow') return 'UnitFlow';
  if (v === 'tower') return 'Tower';
  if (v === 'canonical') return 'Canonical router';
  return v === '' ? 'Unknown venue' : venueId!.trim();
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
  if (lower.includes('no live v3 pool') || lower.includes('cannot cover this') || lower.includes('pool cannot cover') || lower.includes('no swap route') || lower.includes('no route')) {
    return { headline: 'No route is currently available for this pair.', raw: msg };
  }
  if (lower.includes('below minout') || lower.includes('minimum received') || lower.includes('slippage') || lower.includes('amountoutminimum')) {
    return { headline: 'The market moved past your price protection, so the swap was stopped. No output was credited — try again with a fresh quote.', raw: msg };
  }
  if (lower.includes('insufficient')) {
    return { headline: 'Insufficient balance for this swap. Lower the amount and try again.', raw: msg };
  }
  if (lower.includes('payment pin') || lower.includes('step-up') || lower.includes('step_up')) {
    return { headline: 'Your payment PIN is required for this swap. Try again and enter it when asked.', raw: msg };
  }
  if (lower.includes('unbound') || lower.includes('signing identity') || lower.includes('no signing identity')) {
    return { headline: 'Your FlareHQ wallet needs attention before it can swap — no funds moved. Try again later or contact support.', raw: msg };
  }
  if (lower.includes('browser signature') || lower.includes('browser-signing') || lower.includes('approval required')) {
    return { headline: 'This wallet signs in the browser — approve the request in your connected wallet to continue.', raw: msg };
  }
  if (lower.includes('different wallet') || lower.includes('does not match the authenticated wallet')) {
    return { headline: 'The connected wallet does not match your signed-in wallet. Reconnect the same wallet and try again.', raw: msg };
  }
  if (lower.includes('ownership could not be verified') || lower.includes('sign in required')) {
    return { headline: 'Your session expired. Sign in again to continue.', raw: msg };
  }
  if (
    lower.includes('unitflow-v3') &&
    (lower.includes('is disabled') || lower.includes('disabled') || lower.includes('opt-in flag'))
  ) {
    return { headline: 'Swaps are temporarily unavailable. Please try again shortly.', raw: msg };
  }
  if (lower.includes('provider temporarily') || lower.includes('temporarily unavailable') || lower.includes('could not reach the swap service')) {
    return { headline: 'The swap provider is temporarily unavailable. Please try again shortly.', raw: msg };
  }
  if (lower.includes('unavailable') || lower.includes('could not load') || lower.includes('quote failed')) {
    return { headline: 'No swap route is available for this amount right now. Try a smaller amount or try again shortly.', raw: msg };
  }
  if (lower.includes('amount must be') || lower.includes('positive number') || lower.includes('greater than 0')) {
    return { headline: 'Enter a valid amount greater than 0 (up to 6 decimals).', raw: msg };
  }
  if (lower.includes('unsupported swap token') || lower.includes('and eurc only') || lower.includes('eurc, and')) {
    return { headline: 'Flow Swap supports USDC, EURC, and cirBTC.', raw: msg };
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
  // Wrong-chain race (the wallet moved chains between the proactive switch
  // and the send, so viem refused with a chain-mismatch). Never surface the
  // raw "current chain of the wallet (id: …) does not match the target
  // chain" text — prompt the same Arc Testnet switch as the proactive path.
  if (
    lower.includes('does not match the target chain') ||
    lower.includes('current chain of the wallet') ||
    lower.includes('target chain for the transaction') ||
    lower.includes('chain mismatch') ||
    lower.includes('chain id mismatch')
  ) {
    return 'Please switch your wallet to Arc Testnet to continue.';
  }
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
