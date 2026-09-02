// src/app/api/merchant/platform-fees/route.ts
//
// Merchant-facing platform fee visibility. merchantId is derived ONLY from
// the authenticated merchant session (resolveMerchant) — never from a query
// param or request body, same invariant as every other merchant route.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const merchant = await resolveMerchant(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);

        const takeParam = searchParams.get('take');

        let take = 50;
        if (takeParam) {
            const parsed = parseInt(takeParam, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                take = Math.min(parsed, 200);
            }
        }

        const [successAgg, deferredCount, totalCount, fees] = await Promise.all([
            (prisma as any).platformFee.aggregate({
                where: { merchantId: merchant.id, status: 'SUCCESS' },
                _sum: { amountCharged: true },
                _count: true,
            }),
            (prisma as any).platformFee.count({
                where: { merchantId: merchant.id, status: 'DEFERRED' },
            }),
            (prisma as any).platformFee.count({
                where: { merchantId: merchant.id },
            }),
            (prisma as any).platformFee.findMany({
                where: { merchantId: merchant.id },
                orderBy: { createdAt: 'desc' },
                take,
                include: {
                    paymentLog: {
                        select: { reference: true, amount: true, arcTxHash: true },
                    },
                },
            }),
        ]);

        return NextResponse.json({
            success: true,
            feeBps: parseInt(process.env.PLATFORM_FEE_BPS ?? '25', 10),
            totals: {
                successFeesUSDC: Number(((successAgg._sum?.amountCharged ?? 0) as number).toFixed(6)),
                successCount: successAgg._count ?? 0,
                deferredCount,
                totalCount,
            },
            fees: fees.map((f: any) => ({
                id: f.id,
                paymentLogId: f.paymentLogId,
                amountCharged: f.amountCharged,
                amountReceived: f.amountReceived ?? null,
                status: f.status,
                txHash: f.txHash ?? null,
                deferredReason: f.deferredReason ?? null,
                createdAt: f.createdAt,
                paymentLog: f.paymentLog
                    ? {
                          reference: f.paymentLog.reference,
                          amount: f.paymentLog.amount,
                          arcTxHash: f.paymentLog.arcTxHash ?? null,
                      }
                    : null,
            })),
        });
    } catch (error: any) {
        console.error('[Merchant Platform Fees] Error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}
