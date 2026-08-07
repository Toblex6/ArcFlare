// src/app/api/admin/disputes/[reference]/analyze/route.ts
//
// Triggers a new analysis run. Always creates a NEW DisputeAnalysis row
// (version = previous max + 1) rather than overwriting — per the decision
// to version analyses so new evidence produces a fresh result instead of
// clobbering history. Follows the exact resolveAdminSession auth pattern
// used by every other admin/disputes route.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';
import { analyzeDispute } from '@/src/lib/dispute-analysis/orchestrator';

export async function POST(
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

    const latest = await (prisma as any).disputeAnalysis.findFirst({
      where: { reference },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (latest?.version || 0) + 1;

    const pending = await (prisma as any).disputeAnalysis.create({
      data: { reference, status: 'PENDING', version: nextVersion, provider: 'pending' },
    });

    try {
      const { result, providerId } = await analyzeDispute(reference);

      const completed = await (prisma as any).disputeAnalysis.update({
        where: { id: pending.id },
        data: {
          status: 'COMPLETE',
          provider: providerId,
          result: result as any,
          completedAt: new Date(),
        },
      });

      return NextResponse.json({ success: true, analysis: completed });
    } catch (pipelineErr: any) {
      console.error(`❌ Dispute analysis pipeline failed for ${reference}:`, pipelineErr);
      const failed = await (prisma as any).disputeAnalysis.update({
        where: { id: pending.id },
        data: { status: 'FAILED', error: pipelineErr.message || 'Analysis failed.' },
      });
      return NextResponse.json({ success: false, error: failed.error, analysis: failed }, { status: 500 });
    }
  } catch (error: any) {
    console.error('Dispute analysis trigger error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
