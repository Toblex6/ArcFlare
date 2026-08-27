// src/app/api/payments/scheduled/route.ts
// Recurring/scheduled USDC payments — "settle this payment every N days."
// Pairs with a cron job (Render Cron Job or external scheduler) that calls
// POST /api/payments/scheduled/run on an interval (e.g. every hour).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress, getCallerControlledAddresses } from '@/lib/wallet/verifyCallerControlsAddress';

// The platform agent's signing wallet — same explicit resolution as settle
// Path B. Never used as a blanket fallback for arbitrary payers: it is only
// bound to a schedule whose payer is the verified platform agent.
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';

// ── POST /api/payments/scheduled — create a new recurring payment ────────────
async function createScheduledHandler(request: Request) {
  try {
    const {
      payerSCA,
      receiverSCA,
      amount,
      intervalDays,
      maxRuns, // optional — omit for infinite recurring
      description,
      webhookUrl,
      startImmediately = true,
    } = await request.json();

    if (!payerSCA || !receiverSCA || !amount || !intervalDays) {
      return NextResponse.json(
        {
          success: false,
          error: 'payerSCA, receiverSCA, amount and intervalDays are required.',
        },
        { status: 400 }
      );
    }

    // ── SECURITY: the recurring debit comes FROM payerSCA's wallet, so
    // the caller must control it. Without this, any authenticated caller
    // could schedule debits against any victim wallet (or the shared
    // default wallet via the null-wallet fallback).
    const controlsPayer = await verifyCallerControlsAddress(request as any, payerSCA);
    if (!controlsPayer) {
      return NextResponse.json(
        {
          success: false,
          error: 'You do not control the payer wallet (payerSCA) this schedule would debit.',
        },
        { status: 403 }
      );
    }

    // Resolve the Circle wallet that ACTUALLY signs for payerSCA, from the
    // bound records only — the body's payerWalletId is deliberately ignored.
    // A caller-supplied wallet ID was a free-choice debit vector: this route
    // previously persisted `payerWalletId` from the body (or null), and
    // /scheduled/run silently fell back to DEFAULT_PAYER_WALLET_ID for null
    // rows — the C1-class drain. The wallet must be BOUND to the payer:
    //   - consumer                  → ConsumerAccount.circleWalletId
    //   - merchant's own wallet     → Merchant.circleWalletId
    //   - platform agent (internal) → DEFAULT_PAYER_WALLET_ID (its signing
    //     wallet — same explicit resolution as settle Path B, NOT a fallback)
    //   - registered agent          → AgentRegistry.circleWalletId
    //   - x402 buyer/agent EOAs     → no Circle-custodied wallet → refused
    // Chosen variant (of Opus's two): resolve correctly for agent payers at
    // creation AND refuse to persist a row with no bound wallet — belt and
    // braces, so /scheduled/run can fail closed on null with no legacy holes.
    let resolvedPayerWalletId: string | undefined;

    if (controlsPayer.type === 'consumer') {
      const consumerAccount = await (prisma as any).consumerAccount.findUnique({
        where: { walletAddress: payerSCA },
      });

      if (consumerAccount?.walletType === 'EXTERNAL') {
        return NextResponse.json(
          {
            success: false,
            error: `Wallet ${payerSCA} is an external (non-custodial) wallet — ArcFlare does not hold its private key, so it can't be debited automatically on a schedule. Recurring "Save" currently only works with a Flow-created (Circle-custodied) wallet.`,
          },
          { status: 400 }
        );
      }

      resolvedPayerWalletId = consumerAccount?.circleWalletId || undefined;
    } else if (controlsPayer.type === 'merchant') {
      const merchant = await (prisma as any).merchant.findUnique({
        where: { id: controlsPayer.id },
      });
      if (merchant?.walletAddress?.toLowerCase() === payerSCA.toLowerCase()) {
        resolvedPayerWalletId = merchant.circleWalletId || undefined;
      }
      // A merchant claiming its x402 buyer EOA or an agent payment EOA
      // resolves to nothing — those EOAs are not Circle-custodied and can
      // never be auto-debited; refused below.
    } else if (controlsPayer.type === 'agent') {
      const platformAgent = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
      if (controlsPayer.walletAddress.toLowerCase() === platformAgent) {
        // The platform agent's signing wallet IS the platform default —
        // same explicit resolution settle/route.ts Path B uses. This is a
        // verified identity binding, not a fallback for arbitrary payers.
        resolvedPayerWalletId = DEFAULT_PAYER_WALLET_ID;
      } else {
        const agentRecord = await (prisma as any).agentRegistry.findFirst({
          where: { scaAddress: { equals: payerSCA, mode: 'insensitive' } },
        });
        resolvedPayerWalletId = agentRecord?.circleWalletId || undefined;
      }
    }

    if (!resolvedPayerWalletId) {
      // Fail closed at CREATION: never persist a schedule that can only pay
      // by falling back to the shared platform wallet. /scheduled/run also
      // refuses null rows, but nothing here should ever produce one.
      return NextResponse.json(
        {
          success: false,
          error: `Payer ${payerSCA} has no Circle-custodied wallet bound to it — refusing to persist a recurring payment that cannot pay. Set up the payer's wallet first.`,
        },
        { status: 400 }
      );
    }

    const reference = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const nextRunAt = startImmediately
      ? new Date()
      : new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

    const scheduled = await (prisma as any).scheduledPayment.create({
      data: {
        reference,
        payerSCA,
        payerWalletId: resolvedPayerWalletId,
        receiverSCA,
        amount: parseFloat(amount),
        intervalDays: parseInt(intervalDays),
        nextRunAt,
        maxRuns: maxRuns ? parseInt(maxRuns) : null,
        description: description || null,
        webhookUrl: webhookUrl || null,
        status: 'ACTIVE',
      },
    });

    return NextResponse.json({
      success: true,
      scheduledPayment: scheduled,
      message: `Recurring payment created — ${amount} USDC every ${intervalDays} day(s). First run: ${nextRunAt.toISOString()}.`,
      nextStep: `This will run automatically via the scheduler. To run it manually now, call POST /api/payments/scheduled/run.`,
    });
  } catch (error: any) {
    console.error('❌ Scheduled payment create error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(createScheduledHandler);

// ── GET /api/payments/scheduled — list scheduled payments ────────────────────
async function listScheduledHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const payerSCA = searchParams.get('payerSCA');
    const status = searchParams.get('status');

    // ── SECURITY: scope the listing to schedules the caller controls.
    // Without this, any authenticated caller (API key, cookie, consumer
    // session) can read everyone's recurring payment schedules.
    //
    // BUG FIX (was "my schedule disappeared"): the old implementation ran
    // verifyCallerControlsAddress against `payerSCA || '0x0'` — a single
    // probe that nobody controls when no ?payerSCA= param is passed — so
    // controlledSet was empty for every plain GET and the list was ALWAYS
    // empty. Now the caller's full controlled-address set is enumerated
    // up-front and rows are matched against it.
    const controlled = await getCallerControlledAddresses(request as any);

    if (controlled.size === 0) {
      // Authenticated, but controls no wallet that could ever be a payer.
      return NextResponse.json({ success: true, count: 0, scheduledPayments: [] });
    }

    if (payerSCA && !controlled.has(payerSCA.toLowerCase())) {
      return NextResponse.json(
        { success: false, error: 'You do not control this payer wallet.' },
        { status: 403 }
      );
    }

    const schedules = await (prisma as any).scheduledPayment.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(payerSCA
          ? { payerSCA: { equals: payerSCA, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { nextRunAt: 'asc' },
    });

    const filtered = schedules.filter((s: any) => {
      if (!s.payerSCA) return false;
      return payerSCA || controlled.has(s.payerSCA.toLowerCase());
    });

    return NextResponse.json({
      success: true,
      count: filtered.length,
      scheduledPayments: filtered,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKeyOrAnySession(listScheduledHandler);

// ── DELETE /api/payments/scheduled — cancel a scheduled payment ──────────────
async function cancelScheduledHandler(request: Request) {
  try {
    const { reference } = await request.json();

    if (!reference) {
      return NextResponse.json(
        { success: false, error: 'reference is required.' },
        { status: 400 }
      );
    }

    const existing = await (prisma as any).scheduledPayment.findUnique({
      where: { reference },
    });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Scheduled payment not found.' },
        { status: 404 }
      );
    }

    // ── SECURITY: only the controller of the payer wallet may cancel it.
    const controlsPayer = await verifyCallerControlsAddress(request as any, existing.payerSCA);
    if (!controlsPayer) {
      return NextResponse.json(
        {
          success: false,
          error: 'You do not control the payer wallet of this scheduled payment.',
        },
        { status: 403 }
      );
    }

    const updated = await (prisma as any).scheduledPayment.update({
      where: { reference },
      data: { status: 'CANCELLED' },
    });

    return NextResponse.json({
      success: true,
      scheduledPayment: updated,
      message: `Scheduled payment ${reference} cancelled.`,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const DELETE = withApiKeyOrAnySession(cancelScheduledHandler);