// src/app/api/payments/route.ts
//
// Merchant-scoped payment detail read (final-fix pass): this route
// previously returned the FULL PaymentLog row (webhookUrl, gatewayReference,
// circleTxId, idempotencyKey, payerSCA, merchantSCA, senderEmail, ...) to ANY
// unauthenticated caller holding a UUID — a cross-tenant read + secret leak.
//
// There is NO legitimate public caller: zero in-repo fetchers, and public
// checkout verification uses GET /api/payments/verify/[reference] (curated
// projection, untouched). So this route now requires the merchant session /
// API key, scopes strictly by the authenticated merchantId (findFirst —
// unknown-or-foreign ids 404 identically, no existence oracle), and returns
// only the fields a merchant dashboard needs. Rows without a merchantId
// (legacy) are unreadable by anyone — fail closed, not scoped by name.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { z } from 'zod';

// Define a schema for the query parameters
const PaymentQuerySchema = z.object({
  id: z.string().uuid('Invalid payment ID format.'), // Changed to 'id'
});

export async function GET(request: NextRequest) {
  try {
    // 1. Rate Limiting Check
    const { allowed, response: limitResponse } = await checkRateLimit(request, 'payments');
    if (!allowed) return limitResponse;

    // 2. Merchant authentication — no public/anonymous reads.
    const authed = await resolveMerchant(request);
    if (!authed) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated.' },
        { status: 401 }
      );
    }

    // 3. Input Validation
    const { searchParams } = new URL(request.url);
    const query = { id: searchParams.get('id') }; // Changed to 'id'
    const validationResult = PaymentQuerySchema.safeParse(query);

    if (!validationResult.success) {
      return NextResponse.json(
        { success: false, error: validationResult.error.errors },
        { status: 400 }
      );
    }

    const { id } = validationResult.data; // Changed to 'id'

    // 4. Tenant-scoped read: the row must belong to the caller. findFirst
    // (not findUnique-then-compare) so a foreign id is a plain 404.
    const payment = await prisma.paymentLog.findFirst({ where: { id, merchantId: authed.id } });

    if (!payment)
      return NextResponse.json(
        { success: false, error: 'Invoice node not found.' },
        { status: 404 }
      );

    // 5. Minimal projection — only what a merchant dashboard needs. Never
    // webhookUrl, gatewayReference, circleTxId, idempotencyKey, payerSCA,
    // agentSCA, senderEmail, merchantSCA, upstreamOk/Status, or token internals.
    return NextResponse.json({
      success: true,
      payment: {
        id: payment.id,
        reference: payment.reference,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        chain: payment.chain,
        timestamp: payment.timestamp,
        expiresAt: payment.expiresAt,
        arcTxHash: payment.arcTxHash,
      },
    });
  } catch (error) {
    console.error('Database mapping read failure:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
