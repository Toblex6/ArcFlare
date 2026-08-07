// src/app/api/admin/disputes/[reference]/analysis/route.ts
//
// Read-only fetch for the dashboard's AI Evidence Analysis card. Returns the
// latest version by default; ?all=true returns the full version history so
// the dashboard can show "analysis re-run after new evidence" if desired.

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
    const showAll = req.nextUrl.searchParams.get('all') === 'true';

    if (showAll) {
      const analyses = await (prisma as any).disputeAnalysis.findMany({
        where: { reference },
        orderBy: { version: 'desc' },
      });
      return NextResponse.json({ success: true, analyses });
    }

    const latest = await (prisma as any).disputeAnalysis.findFirst({
      where: { reference },
      orderBy: { version: 'desc' },
    });

    return NextResponse.json({ success: true, analysis: latest || null });
  } catch (error: any) {
    console.error('Dispute analysis fetch error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
