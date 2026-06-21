// src/app/api/escrow/list/route.ts
// Returns all escrows with optional status filter.
// Used by the escrow management dashboard.

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status'); // ACTIVE, RELEASED, DISPUTED, REFUNDED
    const depositor = searchParams.get('depositor');
    const beneficiary = searchParams.get('beneficiary');

    const where: any = {};
    if (status) where.status = status;
    if (depositor) where.depositorSCA = depositor;
    if (beneficiary) where.beneficiarySCA = beneficiary;

    const escrows = await (prisma as any).escrow.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();

    // Compute summary metrics
    const active = escrows.filter((e: any) => e.status === 'ACTIVE').length;
    const released = escrows.filter((e: any) => e.status === 'RELEASED').length;
    const disputed = escrows.filter((e: any) => e.status === 'DISPUTED').length;
    const refunded = escrows.filter((e: any) => e.status === 'REFUNDED').length;
    const totalLocked = escrows
      .filter((e: any) => e.status === 'ACTIVE')
      .reduce((sum: number, e: any) => sum + e.amount, 0);
    const totalReleased = escrows
      .filter((e: any) => e.status === 'RELEASED')
      .reduce((sum: number, e: any) => sum + e.amount, 0);

    return NextResponse.json({
      success: true,
      metrics: {
        total: escrows.length,
        active,
        released,
        disputed,
        refunded,
        totalLocked: parseFloat(totalLocked.toFixed(4)),
        totalReleased: parseFloat(totalReleased.toFixed(4)),
      },
      escrows: escrows.map((e: any) => ({
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
