// src/app/api/payments/nano/route.ts
// Record a nanopayment — micro charge (USDC or EURC, Phase 2C) recorded
// instantly in Postgres. Does NOT settle immediately — batched per
// agent + merchant + TOKEN and settled later via /nano/settle.
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
import { resolveCurrency } from '@/lib/tokens/resolveCurrency';
import { resolvePlatformPayerSca } from '@/lib/config/platformDefaults';
import { enforceSpendLimit } from '@/lib/agents/spendWindow';
import { parseUnits } from 'viem';

// The platform's shared default payer (same identity as settle/route.ts) —
// TESTNET-ONLY pin lives in platformDefaults.ts (single authority,
// explicit-or-throw on mainnet). Reachable ONLY from the internal service
// key; a merchant may never name it as the payer of a charge it controls.
// Resolved lazily per request (never at import).
function defaultPayerSca(): string {
  return resolvePlatformPayerSca();
}

async function nanoHandler(request: Request) {
  try {
    const {
      agentSCA, // Agent paying (consumer of service)
      merchantSCA, // Merchant receiving (provider of service)
      amount, // Micro amount e.g. 0.0001 (in the charge's token units)
      description, // What was this charge for e.g. "1 API call", "100 tokens"
      currency, // Phase 2C: charge denomination ("USDC" | "EURC", default USDC)
      tokenAddress, // Phase 2C: canonical token address (must match currency)
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

    // M6: shared usdcAmount rule (decimal string, ≤6 decimals, >0, capped) +
    // isAddress on every receiver/payer field — no float drift.
    if (!/^0x[a-fA-F0-9]{40}$/.test(String(agentSCA)) || !/^0x[a-fA-F0-9]{40}$/.test(String(merchantSCA))) {
      return NextResponse.json(
        { success: false, error: 'agentSCA and merchantSCA must be valid 0x addresses.' },
        { status: 400 }
      );
    }
    const nanoAmountStr = String(amount).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(nanoAmountStr) || !Number.isFinite(parseFloat(nanoAmountStr)) || parseFloat(nanoAmountStr) <= 0 || parseFloat(nanoAmountStr) > 10_000_000) {
      return NextResponse.json(
        { success: false, error: 'amount must be a positive decimal (up to 6 decimals) not exceeding 10,000,000.' },
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
      agentSCA.toLowerCase() === defaultPayerSca().toLowerCase();
    if (!controlsAgent && !(isInternalServiceCall && isPlatformDefaultPayer)) {
      return NextResponse.json(
        {
          success: false,
          error: 'You do not control the payer (agentSCA) of this charge.',
        },
        { status: 403 }
      );
    }

    // Phase 2C: resolve the charge's canonical token through the resolver
    // (rejects unsupported symbols/addresses and symbol/address mismatches —
    // a caller can never record a USDC-denominated row that settles as EURC).
    // Legacy callers omit both fields and record USDC exactly as before.
    let token;
    try {
      token = resolveCurrency({ currency, tokenAddress });
    } catch (tokenError: any) {
      return NextResponse.json(
        { success: false, error: tokenError.message },
        { status: 400 }
      );
    }

    // Record the nanopayment
    // ── Spend-limit gate (audit: spend-limit gap) — BEFORE the row is
    // recorded. A nano charge is a future debit of agentSCA at settlement;
    // recording it against the payer's atomic window (on-chain pre-flight +
    // Serializable row-locked sum) means concurrent micro-charges can never
    // race past the payer's cap before settle executes.
    const amountMicros = parseUnits(String(amount), token.decimals);
    const spendGate = await enforceSpendLimit({
      payerAddress: agentSCA,
      amountMicros,
      context: 'nano:record',
    });
    if (!spendGate.allowed) {
      return NextResponse.json(
        { success: false, error: spendGate.reason ?? 'Spend limit rejected.' },
        { status: 403 }
      );
    }

    const nano = await recordNanoPayment({
      agentSCA,
      merchantSCA,
      amount: parseFloat(nanoAmountStr),
      description,
      currency: token.symbol,
      tokenAddress: token.address,
    });

    // Check current unsettled balance — scoped to THIS token so a USDC
    // charge never nudges an EURC batch over threshold (or vice versa).
    const { total, count } = await getUnsettledBalance(agentSCA, merchantSCA, {
      currency: token.symbol,
      tokenAddress: token.address,
    });
    const readyToSettle = total >= NANO_BATCH_THRESHOLD_USDC;

    return NextResponse.json({
      success: true,
      nano,
      unsettledBalance: total,
      unsettledCount: count,
      currency: token.symbol,
      tokenAddress: token.address,
      readyToSettle,
      message: readyToSettle
        ? `Nanopayment recorded. Batch threshold reached (${total} ${token.symbol}) — call POST /api/payments/nano/settle to settle.`
        : `Nanopayment recorded. ${total.toFixed(6)} ${token.symbol} pending (threshold: ${NANO_BATCH_THRESHOLD_USDC} ${token.symbol}).`,
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
    // Phase 2C: optional token scope (?currency=EURC or ?tokenAddress=0x…).
    // Omit both for the whole-pair view (which now flags mixedTokens).
    const currency = searchParams.get('currency');
    const tokenAddress = searchParams.get('tokenAddress');

    if (!agentSCA || !merchantSCA) {
      return NextResponse.json(
        { success: false, error: 'agentSCA and merchantSCA query params required.' },
        { status: 400 }
      );
    }

    const summary = await getBatchSummary(
      agentSCA,
      merchantSCA,
      currency || tokenAddress ? { currency, tokenAddress } : null
    );

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
