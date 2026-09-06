// src/app/api/payments/quote/route.ts
// POST /api/payments/quote — conversion quote for Payment Routing v1.
//
// Untrusted client input is minimal: { reference, payToken } (pay-in symbol
// only). Exchange rates, output amounts, minOuts, pools, routes, and token
// addresses are NEVER accepted from the client — the server resolves the
// invoice, reads live pool reserves, prices in exact integers, and persists
// a short-lived QUOTED conversion bound to the payment reference.
// Same-token requests return { converted: false } (direct path unchanged).

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, QuoteSchema } from '@/src/lib/validation';
import { requestQuote } from '@/src/lib/routing/quoter';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(QuoteSchema, body);
    if (validationError) return validationError as NextResponse;

    // Only reference + payToken are read — zod strips any attacker-supplied
    // exchangeRate / outputAmount / minOut / pool / route / tokenAddress keys.
    const quote = await requestQuote({ reference: data.reference, payToken: data.payToken });
    return NextResponse.json(quote);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Quote error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Quote failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Payment conversion quoting is active (USDC/EURC only).',
  });
}
