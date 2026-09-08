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
import { resolveRowCurrency } from '@/lib/tokens/resolveCurrency';

// Explicit per-currency buckets — USDC and EURC are never summed as
// fungible units. Legacy/unknown rows degrade to the USDC bucket (the
// pre-multicurrency convention: every such row was created USDC-only).
function bucketize(rows: any[]): { USDC: number; EURC: number } {
    const out = { USDC: 0, EURC: 0 };
    for (const r of rows) {
        let symbol = 'USDC';
        try {
            symbol = resolveRowCurrency({
                currency: r.currency ?? null,
                tokenAddress: r.tokenAddress ?? null,
            }).symbol;
        } catch {
            symbol = 'USDC';
        }
        const amt = Number(r.amount || 0);
        if (symbol === 'EURC') out.EURC += amt;
        else out.USDC += amt;
    }
    out.USDC = Number(out.USDC.toFixed(4));
    out.EURC = Number(out.EURC.toFixed(4));
    return out;
}

// Escrow rows carry `currency` only (no tokenAddress) — bucket on the
// symbol, degrading unknown/legacy values to USDC as above.
function bucketizeBySymbol(rows: any[]): { USDC: number; EURC: number } {
    const out = { USDC: 0, EURC: 0 };
    for (const r of rows) {
        const symbol = String(r.currency ?? 'USDC').trim().toUpperCase();
        const amt = Number(r.amount || 0);
        if (symbol === 'EURC') out.EURC += amt;
        else out.USDC += amt;
    }
    out.USDC = Number(out.USDC.toFixed(4));
    out.EURC = Number(out.EURC.toFixed(4));
    return out;
}

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

        // Canonical per-currency buckets (USDC/EURC never summed). The
        // legacy `totalRevenueUSDC` scalar below is a mixed-unit sum kept
        // for back-compat — prefer `byCurrency`.
        const revenueByCurrency = bucketize(successful);
        const totalRevenue = revenueByCurrency.USDC + revenueByCurrency.EURC;

        // ── Payment link performance (heuristic: links are the only PaymentLog
        // rows created with an expiresAt — see payment-link/route.ts) ─────────
        const links = paymentLogs.filter((p: any) => p.expiresAt !== null);
        const linksSuccessful = links.filter((p: any) => p.status === 'SUCCESS');

        // ── x402 marketplace revenue (real, via ApiListing + PaymentLog.listingId) ──
        const listingIds = new Set(listings.map((l: any) => l.id));
        const x402Payments = paymentLogs.filter((p: any) => p.listingId && listingIds.has(p.listingId));
        const x402Successful = x402Payments.filter((p: any) => p.status === 'SUCCESS');
        const x402ByCurrency = bucketize(x402Successful);
        const x402Revenue = x402ByCurrency.USDC + x402ByCurrency.EURC;

        // ── AI agent activity (real, via PaymentLog.agentSCA) ─────────────────
        const agentPayments = paymentLogs.filter((p: any) => p.agentSCA);
        const agentSuccessful = agentPayments.filter((p: any) => p.status === 'SUCCESS');
        const agentSpendByCurrency = bucketize(agentSuccessful);
        const agentSpend = agentSpendByCurrency.USDC + agentSpendByCurrency.EURC;

        // ── Escrow (real, from Escrow model) ───────────────────────────────────
        const escrowByStatus = escrows.reduce((acc: Record<string, number>, e: any) => {
            acc[e.status] = (acc[e.status] || 0) + 1;
            return acc;
        }, {});
        const escrowValueByCurrency = bucketizeBySymbol(escrows);
        const escrowTotalValue = escrowValueByCurrency.USDC + escrowValueByCurrency.EURC;

        return NextResponse.json({
            success: true,
            revenue: {
                // DEPRECATED mixed-unit sum (USDC + EURC added as raw
                // numbers) — kept for back-compat. Use `byCurrency`.
                totalRevenueUSDC: Number(totalRevenue.toFixed(4)),
                byCurrency: revenueByCurrency,
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
                // DEPRECATED mixed-unit sum — kept for back-compat. Use `valueByCurrency`.
                totalValueUSDC: Number(escrowTotalValue.toFixed(4)),
                valueByCurrency: escrowValueByCurrency,
                byStatus: escrowByStatus,
            },
            x402Marketplace: {
                totalListings: listings.length,
                publishedListings: listings.filter((l: any) => l.status === 'PUBLISHED').length,
                totalRequests: x402Payments.length,
                // DEPRECATED mixed-unit sum — kept for back-compat. Use `revenueByCurrency`.
                revenueUSDC: Number(x402Revenue.toFixed(4)),
                revenueByCurrency: x402ByCurrency,
            },
            aiAgents: {
                totalAgentPayments: agentPayments.length,
                // DEPRECATED mixed-unit sum — kept for back-compat. Use `spendByCurrency`.
                agentSpendUSDC: Number(agentSpend.toFixed(4)),
                spendByCurrency: agentSpendByCurrency,
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