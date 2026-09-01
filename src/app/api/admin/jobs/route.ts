// src/app/api/admin/jobs/route.ts
// Admin-only: list every ERC-8183 job and procurement posting (across all
// merchants) for moderation. Mirrors the /admin/disputes pattern.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';

export async function GET(req: NextRequest) {
    const isAdmin = await resolveAdminSession(req);
    if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    try {
        const [jobs, postings] = await Promise.all([
            (prisma as any).erc8183Job.findMany({
                orderBy: { createdAt: 'desc' },
                take: 200,
                select: {
                    id: true,
                    jobId: true,
                    clientSCA: true,
                    providerSCA: true,
                    evaluatorSCA: true,
                    description: true,
                    budget: true,
                    status: true,
                    merchantId: true,
                    createdAt: true,
                    removedAt: true,
                    removedReason: true,
                },
            }),
            (prisma as any).procurementPosting.findMany({
                orderBy: { createdAt: 'desc' },
                take: 200,
                select: {
                    id: true,
                    seq: true,
                    clientSCA: true,
                    title: true,
                    description: true,
                    budgetMax: true,
                    status: true,
                    merchantId: true,
                    createdAt: true,
                },
            }),
        ]);

        return NextResponse.json({
            success: true,
            jobs: jobs.map((j: any) => ({
                ...j,
                jobId: j.jobId.toString(),
                budget: j.budget.toString(),
                removed: !!j.removedAt,
            })),
            postings: postings.map((p: any) => ({
                ...p,
                humanId: `job${p.seq}`,
                budgetMax: p.budgetMax,
            })),
        });
    } catch (error: any) {
        console.error('Admin jobs list error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
