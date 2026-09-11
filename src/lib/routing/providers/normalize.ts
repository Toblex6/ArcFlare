// src/lib/routing/providers/normalize.ts
//
// Provider quote normalization — Phase 1 foundation.
//
// Converts untrusted provider numeric output into canonical Arc base units:
// - Token identity resolves ONLY through the existing ArcFlare token/config
//   utilities (network-aware: testnet pins, mainnet env inputs). Provider
//   symbols are never trusted; provider addresses must match a supported
//   token or the quote is rejected.
// - USDC and EURC are BOTH 6 decimals on Arc. Any provider-returned decimals
//   claim that disagrees with the canonical 6 is REJECTED with a typed
//   error — never silently converted or coerced.
// - Unknown venues are rejected with a typed error.
// - Pure function: no RPC, no DB, no wallet, no execution.

import { getTokenByAddress } from '../../tokens/supportedTokens';
import { routingError } from '../canonical';
import { KNOWN_VENUE_IDS, type NormalizedProviderQuote, type SwapVenueId } from './types';

/** Canonical Arc decimals for the v1 pair (both 6 — never provider-supplied). */
export const CANONICAL_STABLE_DECIMALS = 6;

/** Untrusted raw provider quote fields (everything here is suspect). */
export interface RawProviderQuote {
  /** Untrusted venue claim — must be a known SwapVenueId. */
  venueId: string;
  /** Untrusted token address claims (0x…). */
  inputToken: string;
  outputToken: string;
  /** Untrusted amounts in claimed base units (integer strings or bigint). */
  inputAmount: string | bigint;
  outputAmount: string | bigint;
  /** Optional untrusted decimals claims. When present they MUST equal 6. */
  inputDecimals?: number | string | null;
  outputDecimals?: number | string | null;
  /** Optional untrusted guaranteed floor (same unit rules as outputAmount). */
  minOut?: string | bigint | null;
}

function isKnownVenueId(v: string): v is SwapVenueId {
  return (KNOWN_VENUE_IDS as readonly string[]).includes(v);
}

function toBigint(label: string, v: string | bigint): bigint {
  try {
    const b = typeof v === 'bigint' ? v : BigInt(String(v).trim());
    if (b <= 0n) throw routingError(400, `Provider quote ${label} must be positive.`);
    return b;
  } catch (e: any) {
    if (typeof (e as any)?.status === 'number') throw e;
    throw routingError(400, `Provider quote ${label} is not an integer string.`);
  }
}

function toOptionalBigint(label: string, v: string | bigint | null | undefined): bigint | undefined {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return undefined;
  return toBigint(label, v);
}

/** Assert an untrusted provider decimals claim equals the canonical value. */
function assertDecimalsClaim(label: string, claimed: number | string | null | undefined): void {
  if (claimed === null || claimed === undefined || (typeof claimed === 'string' && claimed.trim() === '')) {
    return; // no claim made — canonical resolution below is authoritative
  }
  const n = typeof claimed === 'number' ? claimed : Number(String(claimed).trim());
  if (!Number.isInteger(n) || n !== CANONICAL_STABLE_DECIMALS) {
    throw routingError(
      400,
      `Provider quote ${label} decimals mismatch: claimed "${String(claimed)}", canonical is ${CANONICAL_STABLE_DECIMALS}. Rejected — no silent conversion.`
    );
  }
}

/**
 * Normalize an untrusted provider quote into canonical Arc base units.
 * Throws a typed routingError (with .status) on unknown venue, unknown
 * token, decimals mismatch, or malformed amounts. Never coerces bad data.
 */
export function normalizeProviderQuote(raw: RawProviderQuote): NormalizedProviderQuote {
  if (!raw || typeof raw !== 'object') throw routingError(400, 'Provider quote is malformed.');
  if (!isKnownVenueId(raw.venueId)) {
    throw routingError(
      400,
      `Unknown venue "${String((raw as any)?.venueId ?? '')}". Known venues: ${KNOWN_VENUE_IDS.join(', ')}.`
    );
  }

  const inAddr = String(raw.inputToken ?? '').trim();
  const outAddr = String(raw.outputToken ?? '').trim();
  const inToken = inAddr ? getTokenByAddress(inAddr) : undefined;
  const outToken = outAddr ? getTokenByAddress(outAddr) : undefined;
  if (!inToken) throw routingError(400, `Provider quote input token is not a supported ArcFlare token: "${inAddr}".`);
  if (!outToken) throw routingError(400, `Provider quote output token is not a supported ArcFlare token: "${outAddr}".`);
  if (inToken.decimals !== CANONICAL_STABLE_DECIMALS || outToken.decimals !== CANONICAL_STABLE_DECIMALS) {
    // Defensive: canonical config drift must fail closed, never normalize.
    throw routingError(503, 'Canonical token decimals are not 6 — refusing to normalize provider output.');
  }

  // Provider decimals claims are untrusted: reject anything != 6.
  assertDecimalsClaim('input', raw.inputDecimals);
  assertDecimalsClaim('output', raw.outputDecimals);

  const inputAmount = toBigint('inputAmount', raw.inputAmount);
  const quotedOutputAmount = toBigint('outputAmount', raw.outputAmount);
  const minOutputAmount = toOptionalBigint('minOut', raw.minOut);

  return {
    venueId: raw.venueId,
    inputToken: { symbol: inToken.symbol, address: inToken.address, decimals: CANONICAL_STABLE_DECIMALS },
    outputToken: { symbol: outToken.symbol, address: outToken.address, decimals: CANONICAL_STABLE_DECIMALS },
    inputAmount,
    quotedOutputAmount,
    ...(minOutputAmount !== undefined ? { minOutputAmount } : {}),
  };
}
