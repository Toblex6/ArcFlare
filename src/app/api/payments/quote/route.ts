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
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, QuoteSchema } from '@/src/lib/validation';
import { requestQuote } from '@/src/lib/routing/quoter';
import {
  assertSwapSymbol,
  requestCheckoutUnitFlowQuote,
  resolveCheckoutVenueId,
} from '@/src/lib/swap/service';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(QuoteSchema, body);
    if (validationError) return validationError as NextResponse;

    // Venue dispatch (shared swap service): absent → canonical (existing
    // behavior unchanged). Tower is rejected outright (quote-only venue);
    // UnitFlow requires its opt-in flag (fail-closed inside the resolver).
    // Only reference + payToken (+ symbolic venue) are read — zod strips
    // any attacker-supplied exchangeRate / outputAmount / minOut / pool /
    // route / tokenAddress keys.
    const venue = resolveCheckoutVenueId((data as any).venue);
    if (venue === 'canonical') {
      const quote = await requestQuote({ reference: data.reference, payToken: data.payToken });
      return NextResponse.json(quote);
    }

    // ── UnitFlow branch (explicit opt-in only) ──────────────────────────
    // Same pre-checks as the canonical quoter (reference exists,
    // unsettled, unexpired); everything else —
    // settlement token, input sizing, pool/fee validation, recipient, hash —
    // is server-determined inside the service.
    const payment = await prisma.paymentLog.findUnique({ where: { reference: data.reference } });
    if (!payment) {
      return NextResponse.json({ success: false, error: 'Payment reference not found.' }, { status: 404 });
    }
    if (payment.status === 'SUCCESS') {
      return NextResponse.json(
        { success: false, error: 'Payment is already settled — no quote needed.' },
        { status: 409 }
      );
    }
    if (payment.expiresAt && new Date() > payment.expiresAt) {
      return NextResponse.json(
        { success: false, error: 'Payment reference has expired.' },
        { status: 400 }
      );
    }
    const senderHint =
      payment.senderEmail?.startsWith('0x') &&
      payment.senderEmail.toLowerCase() !== 'pending@checkout'
        ? payment.senderEmail
        : payment.payerSCA?.startsWith('0x')
          ? payment.payerSCA
          : null;
    const quote = await requestCheckoutUnitFlowQuote({
      payment,
      payTokenSymbol: assertSwapSymbol(data.payToken),
      senderHint,
    });
    return NextResponse.json({ success: true, ...quote });
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
