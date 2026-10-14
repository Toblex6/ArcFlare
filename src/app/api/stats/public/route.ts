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
            prisma.paymentLog.findMany({ select: { amount: true, status: true, currency: true } }),
            (prisma as any).escrow.findMany({ select: { amount: true, status: true, currency: true } }),
            (prisma as any).agentRegistry.count(),
        ]);

        const successfulPayments = payments.filter((p) => p.status === 'SUCCESS');
        // Per-currency buckets — USDC and EURC amounts are NEVER summed as
        // fungible units. `totalVolume` below is a DEPRECATED mixed-unit sum
        // kept for back-compat; readers must prefer `volumeByCurrency`.
        const bucket = (rows: Array<{ amount: number; currency?: string | null }>) => {
            const out = { USDC: 0, EURC: 0 };
            for (const r of rows) {
                const sym = String(r.currency ?? 'USDC').trim().toUpperCase();
                if (sym === 'EURC') out.EURC += r.amount || 0;
                else out.USDC += r.amount || 0;
            }
            out.USDC = parseFloat(out.USDC.toFixed(6));
            out.EURC = parseFloat(out.EURC.toFixed(6));
            return out;
        };
        const volumeByCurrency = bucket(successfulPayments);
        const totalVolume = successfulPayments.reduce((sum, p) => sum + p.amount, 0);
        const successRate =
            payments.length > 0 ? Math.round((successfulPayments.length / payments.length) * 100) : 0;

        // "Locked" = funds held in escrow that haven't been released or
        // refunded: ACTIVE (awaiting completion) AND DISPUTED (frozen
        // pending admin resolution). The old ACTIVE-only count understated
        // locked funds — /api/escrow/list already counted both.
        const lockedRows = escrows.filter((e: any) => e.status === 'ACTIVE' || e.status === 'DISPUTED');
        const releasedRows = escrows.filter((e: any) => e.status === 'RELEASED');
        const lockedByCurrency = bucket(lockedRows);
        const releasedByCurrency = bucket(releasedRows);
        const totalLocked = lockedRows.reduce((sum: number, e: any) => sum + e.amount, 0);
        const totalReleased = releasedRows.reduce((sum: number, e: any) => sum + e.amount, 0);

        return NextResponse.json({
            success: true,
            data: {
                totalVolume: parseFloat(totalVolume.toFixed(6)),
                volumeByCurrency,
                totalTransactions: payments.length,
                successRate,
                totalEscrows: escrows.length,
                totalLocked: parseFloat(totalLocked.toFixed(4)),
                lockedByCurrency,
                totalReleased: parseFloat(totalReleased.toFixed(4)),
                releasedByCurrency,
                totalAgents: agentCount,
            },
        });
    } catch (error: any) {
        console.error('Public stats error:', error);
        return NextResponse.json({ success: false, error: 'Could not load stats.' }, { status: 500 });
    }
}