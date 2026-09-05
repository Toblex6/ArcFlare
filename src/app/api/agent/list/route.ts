// src/app/api/agent/list/route.ts
//
// GET /api/agent/list — the authenticated merchant's registered agents.
//
// WHY THIS EXISTS: the /agents dashboard refreshes its registry list from
// this exact path after deploying an agent — but the route never existed,
// so every deploy ended with a JSON.parse error on a 404 HTML page shown
// right next to the success banner. This also replaces the old discovery
// path (/api/agent/status) whose `name contains 'Agent'` filter silently
// hid any agent not named "…Agent…".
//
// Scope: merchant-session auth; returns only rows owned by the caller
// (legacy unscoped rows are hidden unless the caller holds the internal
// service key, which sees everything).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';

export async function GET(req: NextRequest) {
  try {
    const merchant = await resolveMerchant(req);
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

    const agents = await (prisma as any).agentRegistry.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenId: true,
        scaAddress: true,
        circleWalletId: true,
        // Troubleshooting/owner-management only: the Hub renders walletSetId
        // inside a collapsed details block, never as a headline identifier.
        walletSetId: true,
        validatorSca: true,
        status: true,
        description: true,
        skills: true,
        pricing: true,
        reputation: true,
        metadataURI: true,
        createdAt: true,
        lastActiveAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      count: agents.length,
      agents,
    });
  } catch (error: any) {
    console.error('[agent/list] Error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
