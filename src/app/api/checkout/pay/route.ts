// src/app/api/checkout/pay/route.ts
// Public-facing settlement trigger for the customer checkout page.
// No API key is exposed to the browser here — this route holds the
// real settlement key server-side and only allows triggering settlement
// for a PENDING reference that already exists, nothing else.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { internalUrl } from '@/src/lib/internalUrl';

export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
        if (!allowed) return limitResponse;

        const body = await req.json().catch(() => ({}));
        const { reference } = body;

        if (!reference || typeof reference !== 'string') {
            return NextResponse.json(
                { success: false, error: 'reference is required.' },
                { status: 400 }
            );
        }

        const payment = await prisma.paymentLog.findUnique({ where: { reference } });
        if (!payment) {
            return NextResponse.json(
                { success: false, error: 'Payment reference not found.' },
                { status: 404 }
            );
        }

        // Only PENDING payments can be triggered this way. Anything already
        // processing/settled/failed goes through settle's own idempotency lock.
        if (!['PENDING', 'SETTLEMENT_ERROR'].includes(payment.status)) {
            return NextResponse.json(
                { success: false, error: 'Payment is not in a payable state.', status: payment.status },
                { status: 409 }
            );
        }

        const settleRes = await fetch(internalUrl('/api/payments/settle'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Server-side only secret — never sent to the browser.
                'x-api-key': process.env.INTERNAL_SETTLEMENT_API_KEY || '',
            },
            body: JSON.stringify({ reference }),
        });

        const settleData = await settleRes.json();
        return NextResponse.json(settleData, { status: settleRes.status });
    } catch (error: any) {
        console.error('Checkout pay error:', error);
        return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
    }
}