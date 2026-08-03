// src/app/api/escrow/list/route.ts
// Returns all escrows with optional status filter.
// Used by the escrow management dashboard.
//
// FIX: metrics (totalLocked, active count, disputed count, etc.) were
// previously computed from the filtered `escrows` array, so clicking
// ACTIVE/DISPUTED/etc. made the metric cards misreport (e.g. Total Locked
// showing 0 while viewing DISPUTED). Metrics now always come from the full,
// unfiltered set for this merchant — the status/depositor/beneficiary
// filters only affect which rows are returned in `escrows`.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const merchant = await resolveMerchant(request);
    if (!merchant) {
      return NextResponse.json(
        { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status'); // ACTIVE, RELEASED, DISPUTED, REFUNDED
    const depositor = searchParams.get('depositor');
    const beneficiary = searchParams.get('beneficiary');

    // ── Fetch ALL of this merchant's escrows first — metrics are always
    //    computed from this full set, regardless of what's being filtered.
    const allEscrows = await (prisma as any).escrow.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });

    // ── Apply status/depositor/beneficiary filters only to what gets
    //    returned as the visible row list.
    const filteredEscrows = allEscrows.filter((e: any) => {
      if (status && e.status !== status) return false;
      if (depositor && e.depositorSCA !== depositor) return false;
      if (beneficiary && e.beneficiarySCA !== beneficiary) return false;
      return true;
    });

    const now = new Date();

    // Compute summary metrics from the FULL set, not the filtered one.
    const active = allEscrows.filter((e: any) => e.status === 'ACTIVE').length;
    const released = allEscrows.filter((e: any) => e.status === 'RELEASED').length;
    const disputed = allEscrows.filter((e: any) => e.status === 'DISPUTED').length;
    const refunded = allEscrows.filter((e: any) => e.status === 'REFUNDED').length;
    const totalLocked = allEscrows
      .filter((e: any) => e.status === 'ACTIVE')
      .reduce((sum: number, e: any) => sum + e.amount, 0);
    const totalReleased = allEscrows
      .filter((e: any) => e.status === 'RELEASED')
      .reduce((sum: number, e: any) => sum + e.amount, 0);

    return NextResponse.json({
      success: true,
      metrics: {
        total: allEscrows.length,
        active,
        released,
        disputed,
        refunded,
        totalLocked: parseFloat(totalLocked.toFixed(4)),
        totalReleased: parseFloat(totalReleased.toFixed(4)),
      },
      escrows: filteredEscrows.map((e: any) => ({
        ...e,
        isExpired: e.deadline ? new Date(e.deadline) < now : false,
        timeRemaining: e.deadline
          ? Math.max(0, Math.floor((new Date(e.deadline).getTime() - now.getTime()) / 1000))
          : null,
        explorerUrl: e.txHash ? `https://testnet.arcscan.app/tx/${e.txHash}` : null,
      })),
    });
  } catch (error: any) {
    console.error('Escrow list error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}