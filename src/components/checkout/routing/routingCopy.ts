// src/components/checkout/routing/routingCopy.ts
//
// Pure, dependency-free presentation helpers for Payment Routing Phase 6.
//
// TERMINOLOGY CONTRACT (payment language, never DEX language): customer
// surfaces use "Pay with", "You pay", "Merchant receives", "Conversion",
// "Rate", "Network/processing fee", "Minimum received". The words below
// must never appear in customer-facing strings — they are allowed only in
// the collapsible technical-details surface (and server logs/errors, which
// are mapped to friendly copy before display).

/** Words banned from customer-facing routing copy. */
export const FORBIDDEN_CUSTOMER_WORDS = [
  'swap',
  'trade',
  'pool',
  'liquidity',
  'exchange tokens',
] as const;

/** True when customer-facing copy uses only payment language. */
export function usesPaymentLanguage(copy: string): boolean {
  const lower = copy.toLowerCase();
  return !FORBIDDEN_CUSTOMER_WORDS.some((w) => lower.includes(w));
}

/** "M:SS" countdown for quote expiry + payment timers. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`;
}

/**
 * Map a raw /api/payments/quote failure to customer-safe copy. The raw
 * server message (which may use venue/venue-math vocabulary) is returned
 * separately for the collapsible technical-details surface — never as the
 * headline.
 */
export function friendlyQuoteError(raw: string | null | undefined): {
  headline: string;
  raw: string | null;
} {
  const msg = (raw ?? '').trim() || 'Quote failed.';
  const lower = msg.toLowerCase();
  if (lower.includes('already settled') || lower.includes('already converted') || lower.includes('consumed')) {
    return { headline: 'This payment is already settled — no quote needed.', raw: msg };
  }
  if (lower.includes('expired') && lower.includes('payment')) {
    return { headline: 'This payment link has expired.', raw: msg };
  }
  if (lower.includes('no recipient wallet')) {
    return { headline: 'This merchant has not finished payout wallet setup yet.', raw: msg };
  }
  if (
    lower.includes('moved against') ||
    lower.includes('disagrees with pricing') ||
    lower.includes('empty quote') ||
    lower.includes('depth') ||
    lower.includes('size cap') ||
    lower.includes('price this')
  ) {
    return {
      headline: 'The conversion rate just moved. Get a fresh quote to continue.',
      raw: msg,
    };
  }
  if (lower.includes('not configured') || lower.includes('does not serve this pair')) {
    return { headline: 'Conversion is temporarily unavailable for this payment. Please try again shortly.', raw: msg };
  }
  if (lower.includes('rpc') || lower.includes('network') || lower.includes('fetch') || lower.includes('failed')) {
    return { headline: 'Could not reach the conversion service. Check your connection and try again.', raw: msg };
  }
  return { headline: 'Could not get a conversion quote. Please try again.', raw: msg };
}
