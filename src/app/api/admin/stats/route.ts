// src/app/api/admin/stats/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';

function bucketByDay(dates: Date[], daysBack: number) {
    const buckets: Record<string, number> = {};
    const now = new Date();
    for (let i = daysBack - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        buckets[key] = 0;
    }
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - daysBack);
    for (const date of dates) {
        if (date < cutoff) continue;
        const key = date.toISOString().slice(0, 10);
        if (key in buckets) buckets[key]++;
    }
    return Object.entries(buckets).map(([date, count]) => ({ date, count }));
}

export async function GET(req: NextRequest) {
    try {
        const isAdmin = await resolveAdminSession(req);
        if (!isAdmin) {
            return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
        }

        const [
            payments,
            merchants,
            consumers,
            circleWallets,
            agentCount,
            escrowCount,
            jobCount,
        ] = await Promise.all([
            prisma.paymentLog.findMany({ select: { amount: true, status: true, timestamp: true } }),
            (prisma as any).merchant.findMany({ select: { createdAt: true, walletType: true } }),
            (prisma as any).consumerAccount.findMany({ select: { createdAt: true, walletType: true } }),
            (prisma as any).circleWallet.findMany({ select: { createdAt: true } }),
            (prisma as any).agentRegistry.count(),
            (prisma as any).escrow.count(),
            (prisma as any).erc8183Job.count(),
        ]);

        const successfulPayments = payments.filter((p) => p.status === 'SUCCESS');
        const totalVolume = successfulPayments.reduce((sum, p) => sum + p.amount, 0);
        const successRate =
            payments.length > 0 ? (successfulPayments.length / payments.length) * 100 : 0;

        const merchantWalletsCircle = merchants.filter((m: any) => m.walletType === 'CIRCLE').length;
        const merchantWalletsExternal = merchants.filter((m: any) => m.walletType === 'EXTERNAL').length;
        const consumerWalletsCircle = consumers.filter((c: any) => c.walletType === 'CIRCLE').length;
        const consumerWalletsExternal = consumers.filter((c: any) => c.walletType === 'EXTERNAL').length;

        return NextResponse.json({
            success: true,
            data: {
                totals: {
                    totalVolume: parseFloat(totalVolume.toFixed(4)),
                    totalTransactions: payments.length,
                    successRate: parseFloat(successRate.toFixed(1)),
                    totalMerchants: merchants.length,
                    totalConsumers: consumers.length,
                    totalWalletsCreated: circleWallets.length + consumerWalletsCircle,
                    totalAgents: agentCount,
                    totalEscrows: escrowCount,
                    totalJobs: jobCount,
                },
                walletBreakdown: {
                    merchantCircle: merchantWalletsCircle,
                    merchantExternal: merchantWalletsExternal,
                    consumerCircle: consumerWalletsCircle,
                    consumerExternal: consumerWalletsExternal,
                },
                newMerchantsPerDay: bucketByDay(
                    merchants.map((m: any) => new Date(m.createdAt)),
                    30
                ),
                newConsumersPerDay: bucketByDay(
                    consumers.map((c: any) => new Date(c.createdAt)),
                    30
                ),
                volumePerDay: (() => {
                    const buckets: Record<string, number> = {};
                    const now = new Date();
                    for (let i = 29; i >= 0; i--) {
                        const d = new Date(now);
                        d.setDate(d.getDate() - i);
                        buckets[d.toISOString().slice(0, 10)] = 0;
                    }
                    const cutoff = new Date(now);
                    cutoff.setDate(cutoff.getDate() - 30);
                    for (const p of successfulPayments) {
                        const date = new Date(p.timestamp);
                        if (date < cutoff) continue;
                        const key = date.toISOString().slice(0, 10);
                        if (key in buckets) buckets[key] += p.amount;
                    }
                    return Object.entries(buckets).map(([date, volume]) => ({
                        date,
                        volume: parseFloat(volume.toFixed(2)),
                    }));
                })(),
            },
        });
    } catch (error: any) {
        console.error('Admin stats error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}