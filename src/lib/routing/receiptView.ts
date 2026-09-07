// src/lib/routing/receiptView.ts
//
// Presentation read-model for routed vs direct payments (Payment Routing
// Phase 6 — UI track). Pure functions over injected rows: no RPC, no DB.
//
// What it answers, authoritatively from the backend rows:
//   - settlementToken: the invoice's frozen settlement token Y (same
//     resolution every read path uses).
//   - payToken: the token the customer actually paid / is paying (X). NULL
//     payTokenAddress (direct or legacy payment) reads as the settlement
//     token — the UI then renders the direct path (X == Y). A stored
//     non-canonical address degrades to null (display fallback), never a
//     guess: only the quoter writes this field, always canonically.
//   - conversion: the live PaymentConversion row with human-readable
//     display amounts, or null when the payment was never quoted.
//
// No semantics change: this module never writes, never re-prices, never
// re-resolves beyond the canonical registry.

import { formatUnits } from 'viem';
import { getTokenByAddress } from '../tokens/supportedTokens';
import { resolveRowCurrency, tokenAddressFor } from '../tokens/resolveCurrency';

export interface TokenView {
  symbol: string;
  address: string;
  decimals: number;
}

export interface ConversionView {
  status: string;
  inputAmount: string;
  inputAmountDisplay: string | null;
  quotedOutputAmount: string;
  quotedOutputDisplay: string | null;
  minOutputAmount: string;
  minOutputDisplay: string | null;
  quoteExpiresAt: string;
  executionTxHash: string | null;
  actualInputAmount: string | null;
  actualInputDisplay: string | null;
  actualOutputAmount: string | null;
  actualOutputDisplay: string | null;
}

function display(raw: string | null | undefined, decimals: number): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/** Canonical settlement token Y for a PaymentLog-shaped row. */
export function settlementTokenView(row: {
  currency?: string | null;
  tokenAddress?: string | null;
}): TokenView {
  try {
    const t = resolveRowCurrency({
      currency: row.currency ?? null,
      tokenAddress: row.tokenAddress ?? null,
    });
    return { symbol: t.symbol, address: t.address, decimals: t.decimals };
  } catch {
    return { symbol: 'USDC', address: tokenAddressFor('USDC'), decimals: 6 };
  }
}

/**
 * Pay-in token X for a PaymentLog-shaped row. NULL payTokenAddress =
 * direct/legacy payment → the settlement token itself (X == Y). Returns
 * null only when the stored address is not a canonical supported token
 * (display fallback — the UI renders the direct path).
 */
export function payTokenView(row: {
  payTokenAddress?: string | null;
  currency?: string | null;
  tokenAddress?: string | null;
}): TokenView | null {
  const raw = (row.payTokenAddress ?? '').trim();
  if (!raw) return settlementTokenView(row);
  const canonical = getTokenByAddress(raw);
  if (!canonical) return null;
  return { symbol: canonical.symbol, address: canonical.address, decimals: canonical.decimals };
}

/** Human-readable view of a PaymentConversion-shaped row, or null. */
export function conversionView(
  row: {
    status: string;
    inputTokenAddress: string;
    inputAmount: string;
    outputTokenAddress: string;
    quotedOutputAmount: string;
    minOutputAmount: string;
    quoteExpiresAt: Date | string;
    executionTxHash?: string | null;
    actualInputAmount?: string | null;
    actualOutputAmount?: string | null;
  } | null | undefined
): ConversionView | null {
  if (!row) return null;
  const inToken = getTokenByAddress(row.inputTokenAddress);
  const outToken = getTokenByAddress(row.outputTokenAddress);
  return {
    status: row.status,
    inputAmount: row.inputAmount,
    inputAmountDisplay: inToken ? display(row.inputAmount, inToken.decimals) : null,
    quotedOutputAmount: row.quotedOutputAmount,
    quotedOutputDisplay: outToken ? display(row.quotedOutputAmount, outToken.decimals) : null,
    minOutputAmount: row.minOutputAmount,
    minOutputDisplay: outToken ? display(row.minOutputAmount, outToken.decimals) : null,
    quoteExpiresAt: new Date(row.quoteExpiresAt).toISOString(),
    executionTxHash: row.executionTxHash ?? null,
    actualInputAmount: row.actualInputAmount ?? null,
    actualInputDisplay: inToken ? display(row.actualInputAmount, inToken.decimals) : null,
    actualOutputAmount: row.actualOutputAmount ?? null,
    actualOutputDisplay: outToken ? display(row.actualOutputAmount, outToken.decimals) : null,
  };
}
