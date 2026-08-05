// src/app/api/admin/disputes/[reference]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ reference: string }> }
) {
    const isAdmin = await resolveAdminSession(req);
    if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    try {
        const { reference } = await params;

        const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
        if (!escrow) {
            return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
        }

        const evidence = await (prisma as any).disputeEvidence.findMany({
            where: { reference },
            orderBy: { createdAt: 'asc' },
        });

        return NextResponse.json({ success: true, escrow, evidence });
    } catch (error: any) {
        console.error('Admin dispute detail error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}