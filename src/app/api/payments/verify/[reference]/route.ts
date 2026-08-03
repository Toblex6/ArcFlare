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
        data: formatResponse(payment),
      });
    }

    return NextResponse.json({
      status: true,
      message:
        payment.status === 'SUCCESS'
          ? 'Verification successful'
          : 'Payment is pending block confirmation',
      data: formatResponse(payment),
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

function formatResponse(payment: any) {
  const hasSettled = payment.status === 'SUCCESS';
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
    merchantSCA: payment.merchantSCA || null,
    paid_at: payment.timestamp,
    // Real data only — no fabricated telemetry. arcTxHash is the actual
    // on-chain transaction hash once verify-onchain confirms a real
    // transfer; it's null until then, not a randomly generated placeholder.
    arcTxHash: payment.arcTxHash || null,
  };
}