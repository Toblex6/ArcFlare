// src/app/api/payments/scheduled/route.ts
// Recurring/scheduled USDC payments — "settle this payment every N days."
// Pairs with a cron job (Render Cron Job or external scheduler) that calls
// POST /api/payments/scheduled/run on an interval (e.g. every hour).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';

// ── POST /api/payments/scheduled — create a new recurring payment ────────────
async function createScheduledHandler(request: Request) {
  try {
    const {
      payerSCA,
      payerWalletId,
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

    // Resolve the real Circle wallet ID for payerSCA up front, instead of
    // leaving payerWalletId null and letting /scheduled/run silently fall
    // back to one shared default wallet for every recurring payment.
    let resolvedPayerWalletId = payerWalletId;
    if (!resolvedPayerWalletId) {
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

      if (consumerAccount?.circleWalletId) {
        resolvedPayerWalletId = consumerAccount.circleWalletId;
      }
    }

    const reference = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const nextRunAt = startImmediately
      ? new Date()
      : new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

    const scheduled = await (prisma as any).scheduledPayment.create({
      data: {
        reference,
        payerSCA,
        payerWalletId: resolvedPayerWalletId || null,
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
    const controlled = await verifyCallerControlsAddress(request as any, payerSCA || '0x0');
    const controlledSet = controlled
      ? new Set([controlled.walletAddress.toLowerCase()])
      : new Set<string>();

    const schedules = await (prisma as any).scheduledPayment.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(payerSCA && !controlled ? { payerSCA: '___none___' } : {}),
      },
      orderBy: { nextRunAt: 'asc' },
    });

    const filtered = schedules.filter((s: any) => {
      if (!s.payerSCA) return false;
      if (payerSCA) return s.payerSCA.toLowerCase() === payerSCA.toLowerCase();
      return controlledSet.has(s.payerSCA.toLowerCase());
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