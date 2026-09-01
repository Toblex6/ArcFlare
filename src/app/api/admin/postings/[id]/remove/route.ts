// src/app/api/admin/postings/[id]/remove/route.ts
// Admin-only moderation: cancel a malicious/bad procurement posting (the
// pre-chain listing). Accepts either the human-facing `job<N>` id or the raw
// cuid. Cancels the posting so it drops off /jobs and no new applies/hires
// can occur; removes its applications.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await resolveAdminSession(req);
  if (!isAdmin) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim() || 'removed by admin';

    let posting: any = null;
    const seqMatch = /^job(\d+)$/i.exec(id);
    if (seqMatch) {
      posting = await (prisma as any).procurementPosting.findUnique({ where: { seq: Number(seqMatch[1]) } });
    }
    if (!posting) {
      posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
    }
    if (!posting) {
      return NextResponse.json({ success: false, error: `posting ${id} not found` }, { status: 404 });
    }

    await (prisma as any).procurementPosting.update({
      where: { id: posting.id },
      data: { status: 'CANCELLED' },
    });
    await (prisma as any).procurementApplication.deleteMany({ where: { procurementId: posting.id } });

    return NextResponse.json({
      success: true,
      postingId: posting.id,
      humanId: `job${posting.seq}`,
      status: 'CANCELLED',
      removedReason: reason,
      applicationsRemoved: true,
    });
  } catch (error: any) {
    console.error('Admin posting remove error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
