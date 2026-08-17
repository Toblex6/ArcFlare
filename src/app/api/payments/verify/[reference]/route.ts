// src/app/api/payments/verify/[reference]/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { reference } = await params;

    if (!reference) {
      return NextResponse.json(
        { status: false, message: 'Transaction reference token is missing.' },
        { status: 400 }
      );
    }

    let payment = await prisma.paymentLog.findUnique({
      where: { reference },
    });

    if (!payment) {
      return NextResponse.json(
        { status: false, message: 'Transaction reference not found.' },
        { status: 404 }
      );
    }

    // Already settled — return cached result
    if (payment.status === 'SUCCESS') {
      return NextResponse.json({
        status: true,
        message: 'Verification successful (Cached Testnet Ledger)',
        data: await formatResponse(payment),
      });
    }

    return NextResponse.json({
      status: true,
      message:
        payment.status === 'SUCCESS'
          ? 'Verification successful'
          : 'Payment is pending block confirmation',
      data: await formatResponse(payment),
    });
  } catch (error: any) {
    console.error('Verify error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}

// Fire and forget webhook
function fireWebhook(url: string, payload: object) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => console.error('Webhook delivery failed:', err.message));
}

async function formatResponse(payment: any) {
  const hasSettled = payment.status === 'SUCCESS';

  // Live merchant-name lookup, resolved fresh every time via merchantId —
  // NOT stored on PaymentLog itself. `payment.merchant` (below) stays exactly
  // as it's always been (businessName, used as a join key elsewhere in the
  // dashboard) so nothing that already depends on it can break. This is
  // purely additive: a display hint for the checkout UI, absent whenever
  // merchantId is missing.
  let merchantUsername: string | null = null;
  if (payment.merchantId) {
    const m = await prisma.merchant.findUnique({
      where: { id: payment.merchantId },
      select: { businessName: true },
    });
    merchantUsername = (m as any)?.businessName || null;
  }

  return {
    id: payment.id,
    reference: payment.reference,
    amount: payment.amount,
    currency: payment.currency,
    chain: payment.chain || 'Arc Testnet',
    gateway_response: hasSettled ? 'Successful' : 'Pending',
    status: payment.status,
    sender_email: payment.senderEmail || null,
    merchant: payment.merchant || null,
    merchant_username: merchantUsername,
    merchantSCA: payment.merchantSCA || null,
    paid_at: payment.timestamp,
    // Real data only — no fabricated telemetry. arcTxHash is the actual
    // on-chain transaction hash once verify-onchain confirms a real
    // transfer; it's null until then, not a randomly generated placeholder.
    arcTxHash: payment.arcTxHash || null,

    // ── Additive, invoice-only fields ──────────────────────────────────
    // paid_at above is preserved unchanged for existing consumers
    // (CheckoutWidget, the checkout page timeline). These three are new
    // and only read by the Invoice component:
    //   issuedAt  — when the payment record was created (payment.timestamp,
    //               same underlying value as paid_at, just honestly named)
    //   settledAt — when it actually settled. Only payment.updatedAt gets
    //               bumped by verify-onchain, so this is the one field
    //               that's genuinely different from issuedAt when a payment
    //               is created and paid at different times. Null until paid.
    //   expiresAt — the real link-expiry deadline already stored on
    //               PaymentLog, reused honestly as the invoice's due date.
    issuedAt: payment.timestamp,
    settledAt: hasSettled ? payment.updatedAt : null,
    expiresAt: payment.expiresAt || null,
  };
}