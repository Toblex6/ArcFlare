// src/app/api/payments/scheduled/route.ts
// Recurring/scheduled USDC payments — "settle this payment every N days."
// Pairs with a cron job (Render Cron Job or external scheduler) that calls
// POST /api/payments/scheduled/run on an interval (e.g. every hour).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';

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

    const reference = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const nextRunAt = startImmediately
      ? new Date()
      : new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

    const scheduled = await (prisma as any).scheduledPayment.create({
      data: {
        reference,
        payerSCA,
        payerWalletId: payerWalletId || null,
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

export const POST = withApiKey(createScheduledHandler);

// ── GET /api/payments/scheduled — list scheduled payments ────────────────────
async function listScheduledHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const payerSCA = searchParams.get('payerSCA');
    const status = searchParams.get('status');

    const where: any = {};
    if (payerSCA) where.payerSCA = payerSCA;
    if (status) where.status = status;

    const schedules = await (prisma as any).scheduledPayment.findMany({
      where,
      orderBy: { nextRunAt: 'asc' },
    });

    return NextResponse.json({
      success: true,
      count: schedules.length,
      scheduledPayments: schedules,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(listScheduledHandler);

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

export const DELETE = withApiKey(cancelScheduledHandler);
