// src/app/api/payments/nano/route.ts
// Record a nanopayment — micro USDC charge recorded instantly in Postgres.
// Does NOT settle immediately — batched and settled later via /nano/settle.
// Used by agents paying per API call, per token, per second of compute etc.

import { NextResponse } from 'next/server';
import { withApiKeyOrMerchant } from '@/src/lib/middleware/withMerchantAuth';
import {
  recordNanoPayment,
  getUnsettledBalance,
  getBatchSummary,
  NANO_BATCH_THRESHOLD_USDC,
} from '@/src/lib/nanopayment';

async function nanoHandler(request: Request) {
  try {
    const {
      agentSCA, // Agent paying (consumer of service)
      merchantSCA, // Merchant receiving (provider of service)
      amount, // Micro amount e.g. 0.0001 USDC
      description, // What was this charge for e.g. "1 API call", "100 tokens"
    } = await request.json();

    if (!agentSCA || !merchantSCA || !amount) {
      return NextResponse.json(
        {
          success: false,
          error: 'agentSCA, merchantSCA and amount are required.',
        },
        { status: 400 }
      );
    }

    if (parseFloat(amount) <= 0) {
      return NextResponse.json(
        { success: false, error: 'Amount must be greater than 0.' },
        { status: 400 }
      );
    }

    // Record the nanopayment
    const nano = await recordNanoPayment({
      agentSCA,
      merchantSCA,
      amount: parseFloat(amount),
      description,
    });

    // Check current unsettled balance
    const { total, count } = await getUnsettledBalance(agentSCA, merchantSCA);
    const readyToSettle = total >= NANO_BATCH_THRESHOLD_USDC;

    return NextResponse.json({
      success: true,
      nano,
      unsettledBalance: total,
      unsettledCount: count,
      readyToSettle,
      message: readyToSettle
        ? `Nanopayment recorded. Batch threshold reached (${total} USDC) — call POST /api/payments/nano/settle to settle.`
        : `Nanopayment recorded. ${total.toFixed(6)} USDC pending (threshold: ${NANO_BATCH_THRESHOLD_USDC} USDC).`,
    });
  } catch (error: any) {
    console.error('Nano record error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrMerchant(nanoHandler);

// ─── GET: Check unsettled balance for a pair ──────────────────────────────────
export const dynamic = 'force-dynamic';

async function getNanoHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentSCA = searchParams.get('agentSCA');
    const merchantSCA = searchParams.get('merchantSCA');

    if (!agentSCA || !merchantSCA) {
      return NextResponse.json(
        { success: false, error: 'agentSCA and merchantSCA query params required.' },
        { status: 400 }
      );
    }

    const summary = await getBatchSummary(agentSCA, merchantSCA);

    return NextResponse.json({
      success: true,
      ...summary,
      thresholdUSDC: NANO_BATCH_THRESHOLD_USDC,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKeyOrMerchant(getNanoHandler);
