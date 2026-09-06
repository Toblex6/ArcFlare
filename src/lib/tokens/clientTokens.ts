// src/lib/tokens/clientTokens.ts
//
// Client-safe token metadata layer for multicurrency Phase 2B.
//
// This module is the ONLY token metadata import allowed in browser components
// (CheckoutWidget, merchant dashboard, consumer surfaces). It re-exports the
// canonical server registry (`supportedTokens.ts` — the single token table,
// verified on-chain, dependency-free and therefore browser-safe) plus tiny
// presentation helpers. It hardcodes NO addresses, NO decimals, and performs
// NO conversion: the invoice's token is authoritative everywhere.
//
// Rules:
//   - Never add a token table here. Import from './supportedTokens'.
//   - Never convert between tokens here (no SwapPool, no pricing).
//   - CCTP support is USDC-only (no EURC CCTP mechanism exists in this repo).
//   - USDC_CONTRACT / USDC_DECIMALS below are legacy-compat aliases derived
//     from the canonical registry (legacy rows without token identity resolve
//     to USDC) — not a second source of truth.

import {
  SUPPORTED_TOKENS,
  getTokenBySymbol,
  getTokenByAddress,
  type SupportedToken,
} from './supportedTokens';

export type SupportedCurrency = 'USDC' | 'EURC';

export const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = ['USDC', 'EURC'] as const;

// Legacy-compat aliases, derived from the canonical registry — the ONLY place
// a raw contract address/decimal enters the browser bundle.
export const USDC_CONTRACT: string = SUPPORTED_TOKENS.USDC.address;
export const USDC_DECIMALS: number = SUPPORTED_TOKENS.USDC.decimals;

export type { SupportedToken };
export { SUPPORTED_TOKENS, getTokenBySymbol, getTokenByAddress };

/** Normalize free-form input to a supported currency, or null (never guess). */
export function normalizeClientSymbol(input?: string | null): SupportedCurrency | null {
  const s = (input ?? '').trim().toUpperCase();
  return s === 'USDC' || s === 'EURC' ? s : null;
}

/** Canonical metadata for a supported symbol. Throws on unsupported input. */
export function getClientToken(symbol: string): SupportedToken {
  const normalized = normalizeClientSymbol(symbol);
  if (!normalized) throw new Error(`unsupported token symbol: "${symbol ?? ''}"`);
  return getTokenBySymbol(normalized);
}

/** Resolve invoice-shaped data to a display token. Legacy rows fall back to USDC. */
export function resolveClientToken(ref: {
  currency?: string | null;
  token?: { symbol: string; address: string; decimals: number } | null;
}): SupportedToken {
  if (ref.token) {
    const byAddress = getTokenByAddress(ref.token.address);
    if (byAddress) return byAddress;
  }
  try {
    return getClientToken(ref.currency ?? '');
  } catch {
    return SUPPORTED_TOKENS.USDC;
  }
}

/** CCTP remains USDC-only — no EURC cross-chain mechanism exists. */
export function isCctpSupported(symbol?: string | null): boolean {
  return normalizeClientSymbol(symbol) === 'USDC';
}

/** "1.5 USDC" — amount display ALWAYS carries its symbol (never a bare number). */
export function formatTokenAmount(amount: number | string, symbol?: string | null): string {
  const normalized = normalizeClientSymbol(symbol) ?? 'USDC';
  return `${amount} ${normalized}`;
}

/** Short contract identity for token badges (first 6 + last 4 chars). */
export function shortTokenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
