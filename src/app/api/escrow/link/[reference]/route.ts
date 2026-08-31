// src/app/api/escrow/link/[reference]/route.ts
// PUBLIC endpoint backing the /escrow-pay/[reference] page. Returns only the
// fields an outsider needs to fund the escrow from their own external wallet.
// No auth — the reference is the capability — and deliberately NO
// Circle-custodial funding path exists here or anywhere in this flow.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { reference } = await params;
    const escrow = await prisma.escrow.findUnique({ where: { reference } });
    if (!escrow) {
      return NextResponse.json({ success: false, error: 'Escrow request not found.' }, { status: 404 });
    }

    const expired = escrow.deadline ? escrow.deadline.getTime() < Date.now() : false;

    return NextResponse.json({
      success: true,
      escrow: {
        reference: escrow.reference,
        amount: escrow.amount,
        currency: escrow.currency,
        beneficiarySCA: escrow.beneficiarySCA,
        condition: escrow.condition,
        deadline: escrow.deadline,
        status: escrow.status,
        contractAddress: escrow.contractAddress,
        depositorSCA: escrow.status === 'PENDING_FUNDING' ? null : escrow.depositorSCA,
        funded: escrow.status !== 'PENDING_FUNDING',
        expired,
      },
    });
  } catch (error: any) {
    console.error('Escrow link detail error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
