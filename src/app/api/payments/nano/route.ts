// src/app/api/payments/nano/route.ts
// Record a nanopayment — micro USDC charge recorded instantly in Postgres.
// Does NOT settle immediately — batched and settled later via /nano/settle.
// Used by agents paying per API call, per token, per second of compute etc.

import { NextResponse } from 'next/server';
import { withApiKeyOrMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/src/lib/wallet/verifyCallerControlsAddress';
import { prisma } from '@/lib/prisma';
import {
  recordNanoPayment,
  getUnsettledBalance,
  getBatchSummary,
  NANO_BATCH_THRESHOLD_USDC,
} from '@/src/lib/nanopayment';

// The platform's shared default payer (same identity as settle/route.ts) —
// reachable ONLY from the internal service key; a merchant may never name
// it as the payer of a charge it controls.
const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';

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

    // ── SECURITY (C1-class): the caller must control the PAYER side of
    // this charge — agentSCA is the wallet that gets debited at settlement
    // time. The previous either-party guard let a caller who controlled
    // only merchantSCA open charges against the shared platform default
    // payer and then force-settle them to drain DEFAULT_PAYER_WALLET_ID.
    // Now: a merchant must own the agent it charges against (or its own
    // wallet when acting as its own agent), and the platform default payer
    // is reachable only from the platform's internal service key.
    const controlsAgent = await verifyCallerControlsAddress(request as any, agentSCA);
    const apiKey = request.headers.get('x-api-key');
    const isInternalServiceCall = apiKey
      ? !!(await (prisma as any).apiKey.findUnique({ where: { key: apiKey } }))
      : false;
    const isPlatformDefaultPayer =
      agentSCA.toLowerCase() === DEFAULT_PAYER_SCA.toLowerCase();
    if (!controlsAgent && !(isInternalServiceCall && isPlatformDefaultPayer)) {
      return NextResponse.json(
        {
          success: false,
          error: 'You do not control the payer (agentSCA) of this charge.',
        },
        { status: 403 }
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
