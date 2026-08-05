// src/app/api/admin/disputes/route.ts
// Lists every DISPUTED escrow across all merchants — admin session only.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';

export async function GET(req: NextRequest) {
    const isAdmin = await resolveAdminSession(req);
    if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    try {
        const disputes = await (prisma as any).escrow.findMany({
            where: { status: 'DISPUTED' },
            orderBy: { createdAt: 'desc' },
        });

        const evidenceCounts = await (prisma as any).disputeEvidence.groupBy({
            by: ['reference'],
            _count: { id: true },
            where: { reference: { in: disputes.map((d: any) => d.reference) } },
        });
        const countMap = Object.fromEntries(evidenceCounts.map((e: any) => [e.reference, e._count.id]));

        return NextResponse.json({
            success: true,
            disputes: disputes.map((d: any) => ({ ...d, evidenceCount: countMap[d.reference] || 0 })),
        });
    } catch (error: any) {
        console.error('Admin disputes list error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}