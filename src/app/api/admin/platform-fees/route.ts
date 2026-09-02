// src/app/api/admin/platform-fees/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';

const ALLOWED_STATUSES = new Set(['SUCCESS', 'FAILED', 'DEFERRED', 'PENDING']);

export async function GET(req: NextRequest) {
    const isAdmin = await resolveAdminSession(req);
    if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(req.url);

        const statusParam = searchParams.get('status');
        const merchantIdParam = searchParams.get('merchantId');
        const takeParam = searchParams.get('take');

        let take = 100;
        if (takeParam) {
            const parsed = parseInt(takeParam, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                take = Math.min(parsed, 200);
            }
        }

        const where: Record<string, unknown> = {};
        if (statusParam && ALLOWED_STATUSES.has(statusParam)) {
            where.status = statusParam;
        }
        if (merchantIdParam) {
            where.merchantId = merchantIdParam;
        }

        const fees = await (prisma as any).platformFee.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take,
            include: {
                paymentLog: {
                    select: { reference: true, amount: true, arcTxHash: true },
                },
            },
        });

        // Lookup merchant business names for returned fees
        const merchantIds = [...new Set(fees.map((f: any) => f.merchantId).filter(Boolean))] as string[];
        const merchantMap = new Map<string, string>();
        if (merchantIds.length > 0) {
            const merchants = await (prisma as any).merchant.findMany({
                where: { id: { in: merchantIds } },
                select: { id: true, businessName: true },
            });
            for (const m of merchants as any[]) {
                merchantMap.set(m.id, m.businessName);
            }
        }

        return NextResponse.json({
            success: true,
            fees: fees.map((f: any) => ({
                id: f.id,
                paymentLogId: f.paymentLogId,
                merchantId: f.merchantId,
                merchantName: merchantMap.get(f.merchantId) ?? null,
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
        console.error('Admin platform-fees list error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
