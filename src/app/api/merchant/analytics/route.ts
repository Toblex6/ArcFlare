// src/app/api/merchant/analytics/route.ts
//
// Merchant-facing analytics. Extends the existing PaymentLog/Escrow/ApiListing
// data — same aggregation pattern as payments/all — rather than introducing a
// parallel analytics store.
//
// Deliberately does NOT include "CCTP transfers" or "webhook delivery logs"
// as categories: nothing in the schema tracks CCTP domain/nonce data or
// webhook delivery outcomes today (webhookUrl is stored, but whether it fired
// or succeeded isn't). Faking those numbers was the exact problem just fixed
// in payments/all — not repeating it here. Once real tracking exists for
// either, add real sections for them.

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

        const [paymentLogs, escrows, listings] = await Promise.all([
            prisma.paymentLog.findMany({ where: { merchantId: merchant.id } }),
            (prisma as any).escrow.findMany({ where: { merchantId: merchant.id } }),
            (prisma as any).apiListing.findMany({ where: { merchantId: merchant.id } }),
        ]);
        // ScheduledPayment and PayrollBatch have no merchantId FK in the current
        // schema — they're scoped by payerSCA instead, which this endpoint has
        // no reliable way to map back to a merchant without guessing. Left out
        // rather than aggregated incorrectly. Add a merchantId FK to both if
        // this data is actually wanted here.

        // ── Revenue & volume (real, from PaymentLog) ──────────────────────────
        const successful = paymentLogs.filter((p: any) => p.status === 'SUCCESS');
        const failed = paymentLogs.filter((p: any) => p.status === 'FAILED');
        const pending = paymentLogs.filter((p: any) => p.status === 'PENDING');

        const totalRevenue = successful.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

        // ── Payment link performance (heuristic: links are the only PaymentLog
        // rows created with an expiresAt — see payment-link/route.ts) ─────────
        const links = paymentLogs.filter((p: any) => p.expiresAt !== null);
        const linksSuccessful = links.filter((p: any) => p.status === 'SUCCESS');

        // ── x402 marketplace revenue (real, via ApiListing + PaymentLog.listingId) ──
        const listingIds = new Set(listings.map((l: any) => l.id));
        const x402Payments = paymentLogs.filter((p: any) => p.listingId && listingIds.has(p.listingId));
        const x402Revenue = x402Payments
            .filter((p: any) => p.status === 'SUCCESS')
            .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

        // ── AI agent activity (real, via PaymentLog.agentSCA) ─────────────────
        const agentPayments = paymentLogs.filter((p: any) => p.agentSCA);
        const agentSpend = agentPayments
            .filter((p: any) => p.status === 'SUCCESS')
            .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

        // ── Escrow (real, from Escrow model) ───────────────────────────────────
        const escrowByStatus = escrows.reduce((acc: Record<string, number>, e: any) => {
            acc[e.status] = (acc[e.status] || 0) + 1;
            return acc;
        }, {});
        const escrowTotalValue = escrows.reduce((sum: number, e: any) => sum + (e.amount || 0), 0);

        return NextResponse.json({
            success: true,
            revenue: {
                totalRevenueUSDC: Number(totalRevenue.toFixed(4)),
                successfulPayments: successful.length,
                failedPayments: failed.length,
                pendingPayments: pending.length,
                totalPayments: paymentLogs.length,
                successRate: paymentLogs.length > 0 ? Math.round((successful.length / paymentLogs.length) * 100) : 0,
            },
            paymentLinks: {
                totalLinks: links.length,
                successfulLinks: linksSuccessful.length,
                conversionRate: links.length > 0 ? Math.round((linksSuccessful.length / links.length) * 100) : 0,
            },
            escrow: {
                totalEscrows: escrows.length,
                totalValueUSDC: Number(escrowTotalValue.toFixed(4)),
                byStatus: escrowByStatus,
            },
            x402Marketplace: {
                totalListings: listings.length,
                publishedListings: listings.filter((l: any) => l.status === 'PUBLISHED').length,
                totalRequests: x402Payments.length,
                revenueUSDC: Number(x402Revenue.toFixed(4)),
            },
            aiAgents: {
                totalAgentPayments: agentPayments.length,
                agentSpendUSDC: Number(agentSpend.toFixed(4)),
            },
            // Explicitly surfaced as unavailable rather than silently omitted or
            // faked — see file header for why.
            notTracked: {
                cctpTransfers: 'No CCTP-specific fields exist in PaymentLog yet — chain field is free text, not structured domain/nonce data.',
                webhookDeliveryLogs: 'webhookUrl is stored on PaymentLog/Stream/ScheduledPayment/PayrollBatch, but delivery attempts and outcomes are not logged anywhere.',
            },
        });
    } catch (error: any) {
        console.error('[Merchant Analytics] Error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}