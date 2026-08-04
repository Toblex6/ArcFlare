// src/app/api/x402/marketplace/[slug]/analytics/route.ts
// Usage analytics for a listing, sourced entirely from PaymentLog via
// listingId — no separate analytics store, per the implementation guide.
// Owning merchant only.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    try {
        const merchant = await resolveMerchant(request);
        if (!merchant) {
            return NextResponse.json(
                { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
                { status: 401 }
            );
        }

        const { slug } = await params;
        const listing = await (prisma as any).apiListing.findUnique({ where: { slug } });

        if (!listing) {
            return NextResponse.json({ success: false, error: 'Listing not found.' }, { status: 404 });
        }
        if (listing.merchantId !== merchant.id) {
            return NextResponse.json(
                { success: false, error: 'You do not own this listing.' },
                { status: 403 }
            );
        }

        const payments = (await prisma.paymentLog.findMany({
            where: { listingId: listing.id },
            orderBy: { timestamp: 'desc' },
        })) as Array<{
            reference: string;
            amount: number;
            status: string;
            arcTxHash: string | null;
            gatewayReference: string | null;
            upstreamOk: boolean | null;
            upstreamStatus: number | null;
            timestamp: Date;
            senderEmail: string;
        }>;

        const successCount = payments.filter((p) => p.status === 'SUCCESS').length;
        const totalRevenue = payments
            .filter((p) => p.status === 'SUCCESS')
            .reduce((sum: number, p) => sum + p.amount, 0);

        // Delivery outcome is only meaningful for payments where we recorded it
        // (upstreamOk !== null) — older rows predate this tracking.
        const withDeliveryData = payments.filter((p) => p.upstreamOk !== null);
        const deliveredCount = withDeliveryData.filter((p) => p.upstreamOk === true).length;

        return NextResponse.json({
            success: true,
            listing: { slug: listing.slug, name: listing.name, status: listing.status },
            analytics: {
                totalRequests: payments.length,
                successfulPayments: successCount,
                failedPayments: payments.length - successCount,
                totalRevenueUSDC: Number(totalRevenue.toFixed(4)),
                successRate: payments.length > 0 ? Math.round((successCount / payments.length) * 100) : 0,
                // Distinct from payment success — this is "did the merchant's API
                // actually respond OK after the buyer paid."
                deliverySuccessRate:
                    withDeliveryData.length > 0 ? Math.round((deliveredCount / withDeliveryData.length) * 100) : null,
                upstreamFailures: withDeliveryData.filter((p) => p.upstreamOk === false).length,
            },
            recentPayments: payments.slice(0, 25).map((p: (typeof payments)[number]) => ({
                reference: p.reference,
                amount: p.amount,
                status: p.status,
                gatewayReference: p.gatewayReference,
                upstreamOk: p.upstreamOk,
                upstreamStatus: p.upstreamStatus,
                timestamp: p.timestamp,
                payer: p.senderEmail,
            })),
        });
    } catch (error: any) {
        console.error('[Marketplace] Analytics error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}
