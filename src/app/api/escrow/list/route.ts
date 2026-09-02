// src/app/api/escrow/list/route.ts
// Returns all escrows with optional status filter.
// Used by the escrow management dashboard.
//
// FIX (this pass): "Total Locked" now includes DISPUTED escrows alongside
// ACTIVE ones. A dispute doesn't move funds — it just freezes the escrow
// pending admin resolution — so that USDC is still genuinely locked in the
// contract. Only RELEASED/REFUNDED funds have actually left it. Previously
// totalLocked only summed ACTIVE, which understated real locked value
// whenever anything was under dispute.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { getCallerControlledAddresses } from '@/src/lib/wallet/verifyCallerControlsAddress';
import { beneficiaryConfirmUrl } from '@/src/lib/escrow/resolveBeneficiary';

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
    const status = searchParams.get('status');
    const depositor = searchParams.get('depositor');
    const beneficiary = searchParams.get('beneficiary');
    const role = searchParams.get('role'); // "beneficiary" → incoming escrows where caller controls beneficiarySCA

    const now = new Date();

    // ── Incoming view: escrows where the authenticated caller controls the
    // BENEFICIARY address — regardless of which merchant owns the row. Uses
    // the same control set as every other route (own wallet, buyer EOA, owned
    // agents' SCAs + payment EOAs), so a beneficiary merchant/owner sees what
    // they can actually act on via /api/escrow/release.
    if (role === 'beneficiary') {
      const controlled = await getCallerControlledAddresses(request);
      if (controlled.size === 0) {
        return NextResponse.json({ success: true, metrics: { total: 0, active: 0, released: 0, disputed: 0, refunded: 0, totalLocked: 0, totalReleased: 0 }, escrows: [], role: 'beneficiary' });
      }
      const all = await (prisma as any).escrow.findMany({
        orderBy: { createdAt: 'desc' },
      });
      const incoming = all.filter(
        (e: any) => controlled.has(String(e.beneficiarySCA).toLowerCase())
      );
      const active = incoming.filter((e: any) => e.status === 'ACTIVE').length;
      const released = incoming.filter((e: any) => e.status === 'RELEASED').length;
      const disputed = incoming.filter((e: any) => e.status === 'DISPUTED').length;
      const refunded = incoming.filter((e: any) => e.status === 'REFUNDED').length;
      const totalLocked = incoming
        .filter((e: any) => e.status === 'ACTIVE' || e.status === 'DISPUTED')
        .reduce((sum: number, e: any) => sum + e.amount, 0);
      const totalReleased = incoming
        .filter((e: any) => e.status === 'RELEASED')
        .reduce((sum: number, e: any) => sum + e.amount, 0);

      return NextResponse.json({
        success: true,
        role: 'beneficiary',
        metrics: {
          total: incoming.length,
          active,
          released,
          disputed,
          refunded,
          totalLocked: parseFloat(totalLocked.toFixed(4)),
          totalReleased: parseFloat(totalReleased.toFixed(4)),
        },
        escrows: incoming.map((e: any) => ({
          ...e,
          isExpired: e.deadline ? new Date(e.deadline) < now : false,
          timeRemaining: e.deadline
            ? Math.max(0, Math.floor((new Date(e.deadline).getTime() - now.getTime()) / 1000))
            : null,
          explorerUrl: e.txHash ? `https://testnet.arcscan.app/tx/${e.txHash}` : null,
          confirmUrl: beneficiaryConfirmUrl(e.reference),
        })),
      });
    }

    const allEscrows = await (prisma as any).escrow.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });

    const filteredEscrows = allEscrows.filter((e: any) => {
      if (status && e.status !== status) return false;
      if (depositor && e.depositorSCA !== depositor) return false;
      if (beneficiary && e.beneficiarySCA !== beneficiary) return false;
      return true;
    });

    const active = allEscrows.filter((e: any) => e.status === 'ACTIVE').length;
    const released = allEscrows.filter((e: any) => e.status === 'RELEASED').length;
    const disputed = allEscrows.filter((e: any) => e.status === 'DISPUTED').length;
    const refunded = allEscrows.filter((e: any) => e.status === 'REFUNDED').length;

    // Funds still genuinely locked in the contract = ACTIVE + DISPUTED.
    // RELEASED and REFUNDED have already left the contract, so they're
    // excluded here (RELEASED counted separately below, REFUNDED isn't
    // currently surfaced as a total but could be added the same way).
    const totalLocked = allEscrows
      .filter((e: any) => e.status === 'ACTIVE' || e.status === 'DISPUTED')
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
        confirmUrl: beneficiaryConfirmUrl(e.reference),
      })),
    });
  } catch (error: any) {
    console.error('Escrow list error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}