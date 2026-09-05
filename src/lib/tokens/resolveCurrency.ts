// src/lib/tokens/resolveCurrency.ts
//
// Canonical currency/token resolver for first-class USDC + EURC payments.
//
// PHASE 1 READ-MODEL FOUNDATION ONLY. This module resolves which supported
// token an invoice/payment record is denominated in. It does NOT move money,
// does NOT implement EURC settlement, and must not be used to switch any
// transfer/verify/settle path onto EURC yet (that is Phase 2).
//
// Rules (see supportedTokens.ts — the single token table, never duplicated):
//   - An explicit `tokenAddress` MUST resolve to a supported token, or throw.
//   - Otherwise resolve from the `currency` symbol.
//   - Legacy read paths with no token address default to USDC.
//   - New writes should always persist the canonical token address.
//   - Unsupported symbol/address combinations are rejected, never guessed.
//   - Arbitrary ERC-20 addresses are rejected (only SUPPORTED_TOKENS pass).

import { getTokenBySymbol, SUPPORTED_TOKENS, getTokenByAddress } from './supportedTokens';

export interface CurrencyRef {
  symbol: 'USDC' | 'EURC';
  address: string;
  decimals: number;
}

function normalizeSymbol(symbol?: string | null): string {
  return (symbol ?? '').trim().toUpperCase();
}

function isSymbolSupported(symbol: string): symbol is CurrencyRef['symbol'] {
  return symbol === 'USDC' || symbol === 'EURC';
}

/**
 * Resolve an explicit `currency`/`tokenAddress` pair into a canonical
 * supported token. Throws on unsupported symbols, unsupported addresses, or a
 * symbol/address mismatch (so a caller can never smuggle an unvetted ERC-20
 * address in under a supported symbol). Falls back to USDC only when BOTH
 * inputs are empty/missing (legacy write/read shape before Phase 1).
 */
export function resolveCurrency(ref: {
  currency?: string | null;
  tokenAddress?: string | null;
}): CurrencyRef {
  const addr = ref?.tokenAddress?.trim();
  if (addr) {
    const byAddress = getTokenByAddress(addr);
    if (!byAddress) {
      throw new Error(`unsupported token address: ${addr}`);
    }
    const symbol = normalizeSymbol(ref?.currency);
    if (symbol && symbol !== byAddress.symbol) {
      throw new Error(
        `token/symbol mismatch: currency "${symbol}" does not match token ${byAddress.symbol} at ${byAddress.address}`
      );
    }
    return { symbol: byAddress.symbol, address: byAddress.address, decimals: byAddress.decimals };
  }

  // No token address: resolve from currency, defaulting to USDC (legacy rows
  // written before Phase 1 have no address and are USDC by convention).
  const symbol = normalizeSymbol(ref?.currency) || 'USDC';
  if (!isSymbolSupported(symbol)) {
    throw new Error(`unsupported token symbol: "${ref?.currency ?? ''}"`);
  }
  return getTokenBySymbol(symbol);
}

/**
 * Row-shaped variant of `resolveCurrency` for DB rows that carry a legacy
 * `currency` string plus (after Phase 1) an optional `tokenAddress`.
 * Same rules — a NULL tokenAddress resolves from `currency`, defaulting to
 * USDC so historical rows stay valid.
 */
export function resolveRowCurrency(row: {
  currency?: string | null;
  tokenAddress?: string | null;
}): CurrencyRef {
  return resolveCurrency({ currency: row?.currency, tokenAddress: row?.tokenAddress });
}

/**
 * Canonical address for a symbol. Throws for unsupported symbols.
 */
export function tokenAddressFor(symbol: string): string {
  const s = normalizeSymbol(symbol);
  if (!isSymbolSupported(s)) {
    throw new Error(`unsupported token symbol: "${symbol}"`);
  }
  return SUPPORTED_TOKENS[s].address;
}
