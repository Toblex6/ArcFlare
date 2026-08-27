// src/app/api/stats/public/route.ts
// Deliberately public, no auth — but only ever returns platform-wide
// aggregates (sums/counts), never individual merchant or consumer
// records, wallet addresses, or transaction-level detail. That's what
// makes it safe to expose without a login, unlike /api/payments/all.
import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [payments, escrows, agentCount] = await Promise.all([
            prisma.paymentLog.findMany({ select: { amount: true, status: true } }),
            (prisma as any).escrow.findMany({ select: { amount: true, status: true } }),
            (prisma as any).agentRegistry.count(),
        ]);

        const successfulPayments = payments.filter((p) => p.status === 'SUCCESS');
        const totalVolume = successfulPayments.reduce((sum, p) => sum + p.amount, 0);
        const successRate =
            payments.length > 0 ? Math.round((successfulPayments.length / payments.length) * 100) : 0;

        // "Locked" = funds held in escrow that haven't been released or
        // refunded: ACTIVE (awaiting completion) AND DISPUTED (frozen
        // pending admin resolution). The old ACTIVE-only count understated
        // locked funds — /api/escrow/list already counted both.
        const totalLocked = escrows
            .filter((e: any) => e.status === 'ACTIVE' || e.status === 'DISPUTED')
            .reduce((sum: number, e: any) => sum + e.amount, 0);
        const totalReleased = escrows
            .filter((e: any) => e.status === 'RELEASED')
            .reduce((sum: number, e: any) => sum + e.amount, 0);

        return NextResponse.json({
            success: true,
            data: {
                totalVolume: parseFloat(totalVolume.toFixed(6)),
                totalTransactions: payments.length,
                successRate,
                totalEscrows: escrows.length,
                totalLocked: parseFloat(totalLocked.toFixed(4)),
                totalReleased: parseFloat(totalReleased.toFixed(4)),
                totalAgents: agentCount,
            },
        });
    } catch (error: any) {
        console.error('Public stats error:', error);
        return NextResponse.json({ success: false, error: 'Could not load stats.' }, { status: 500 });
    }
}