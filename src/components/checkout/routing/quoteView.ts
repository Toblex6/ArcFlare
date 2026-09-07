// src/components/checkout/routing/quoteView.ts
//
// Client-safe quote view-model builder (browser bundle). Pure function of
// the server-issued quote + canonical token metadata — it never prices,
// never converts, never guesses. All math shown is display formatting of
// server-computed exact integers (formatUnits); the indicative rate is
// explicitly display-only.

import { formatUnits } from 'viem';
import { getClientToken, type SupportedCurrency } from '@/src/lib/tokens/clientTokens';

export interface ServerQuote {
  success: boolean;
  converted: boolean;
  reference: string;
  payToken: { symbol: string; address: string; decimals: number };
  settlementToken: { symbol: string; address: string; decimals: number };
  inputAmount?: string;
  inputAmountDisplay?: string;
  quotedOutputAmount?: string;
  minOutputAmount?: string;
  quoteExpiresAt?: string;
  deadline?: number;
  quoteHash?: string;
  router?: string;
  recipient?: string;
  slippageBps?: number;
  idempotencyKey?: string;
}

export interface QuoteViewModel {
  paySymbol: SupportedCurrency;
  payAddress: string;
  payDecimals: number;
  settlementSymbol: SupportedCurrency;
  settlementAddress: string;
  settlementDecimals: number;
  /** Exact quoted pay-in, X display units (server-computed). */
  payAmountDisplay: string;
  /** Expected merchant credit, Y display units (server-computed). */
  quotedOutputDisplay: string;
  /** Binding floor credited to the merchant, Y display units. */
  minOutputDisplay: string;
  /** Indicative rate, display only — e.g. "1 EURC ≈ 1.0756 USDC". */
  rateDisplay: string;
  slippageBps: number;
  expiresAtMs: number;
  deadlineSec: number;
  quoteHash: string;
  router: string;
  recipient: string;
  inputAmountBase: string;
  minOutputBase: string;
}

function displayOf(base: string | undefined, decimals: number): string {
  if (base === undefined) throw new Error('Quote is missing an amount.');
  return formatUnits(BigInt(base), decimals);
}

/**
 * Build the customer-facing view-model from a converted server quote.
 * Throws on non-converted quotes, unknown token symbols, or malformed
 * amounts — the caller renders the error state.
 */
export function toQuoteViewModel(quote: ServerQuote): QuoteViewModel {
  if (!quote || quote.converted !== true) {
    throw new Error('No conversion in this quote (direct payment).');
  }
  const pay = getClientToken(quote.payToken.symbol);
  const settlement = getClientToken(quote.settlementToken.symbol);
  if (pay.symbol === settlement.symbol) {
    throw new Error('Quote pay token matches the settlement token (direct payment).');
  }
  const payAmountDisplay = quote.inputAmountDisplay ?? displayOf(quote.inputAmount, pay.decimals);
  const quotedOutputDisplay = displayOf(quote.quotedOutputAmount, settlement.decimals);
  const minOutputDisplay = displayOf(quote.minOutputAmount, settlement.decimals);
  const expiresAtMs = new Date(quote.quoteExpiresAt as string).getTime();
  if (!Number.isFinite(expiresAtMs)) throw new Error('Quote is missing an expiry.');

  // Indicative rate for display only — the binding numbers are the exact
  // amounts above, enforced on-chain.
  let rateDisplay = `1 ${pay.symbol} ≈ ? ${settlement.symbol}`;
  const payNum = Number(payAmountDisplay);
  const outNum = Number(quotedOutputDisplay);
  if (Number.isFinite(payNum) && Number.isFinite(outNum) && payNum > 0) {
    const rate = outNum / payNum;
    const formatted = rate >= 100 ? rate.toFixed(2) : rate >= 1 ? rate.toFixed(4) : rate.toPrecision(4);
    rateDisplay = `1 ${pay.symbol} ≈ ${formatted} ${settlement.symbol}`;
  }

  return {
    paySymbol: pay.symbol as SupportedCurrency,
    payAddress: pay.address,
    payDecimals: pay.decimals,
    settlementSymbol: settlement.symbol as SupportedCurrency,
    settlementAddress: settlement.address,
    settlementDecimals: settlement.decimals,
    payAmountDisplay,
    quotedOutputDisplay,
    minOutputDisplay,
    rateDisplay,
    slippageBps: quote.slippageBps ?? 100,
    expiresAtMs,
    deadlineSec: quote.deadline ?? Math.floor(expiresAtMs / 1000),
    quoteHash: quote.quoteHash ?? '',
    router: quote.router ?? '',
    recipient: quote.recipient ?? '',
    inputAmountBase: quote.inputAmount ?? '',
    minOutputBase: quote.minOutputAmount ?? '',
  };
}
