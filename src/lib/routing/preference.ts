// src/lib/routing/preference.ts
//
// Merchant settlement-preference helpers (Payment Routing v1). The preference
// is ONE canonical token-identity field (settlementTokenAddress) that the
// canonical resolver understands. NULL = USDC default. It applies to FUTURE
// invoices only — existing PaymentLog rows are frozen at creation and are
// never mutated by a preference change.

import { getTokenBySymbol } from '../tokens/supportedTokens';
import { resolveCurrency } from '../tokens/resolveCurrency';
import type { CurrencyRef } from '../tokens/resolveCurrency';

// Default settlement token for a merchant's future invoices. Throws on a
// stored non-canonical address (fail closed — never guess a token).
export function resolveMerchantSettlementPreference(merchant: {
  settlementTokenAddress?: string | null;
}): CurrencyRef {
  const pref = merchant?.settlementTokenAddress?.trim();
  if (!pref) return getTokenBySymbol('USDC');
  const resolved = resolveCurrency({ tokenAddress: pref });
  return { symbol: resolved.symbol, address: resolved.address, decimals: resolved.decimals };
}

// Validate a caller-supplied preference change. Accepts a symbol, an
// address, or both (both must agree — mismatch is rejected). Returns the
// canonical address to persist.
export function resolvePreferenceUpdate(input: {
  settlementToken?: string | null;
  settlementTokenAddress?: string | null;
}): string {
  const symbol = input.settlementToken?.trim().toUpperCase();
  const address = input.settlementTokenAddress?.trim();
  if (!symbol && !address) {
    throw new Error('Provide settlementToken ("USDC" | "EURC") and/or settlementTokenAddress.');
  }
  const resolved = resolveCurrency({
    currency: symbol || undefined,
    tokenAddress: address || undefined,
  });
  return resolved.address;
}
