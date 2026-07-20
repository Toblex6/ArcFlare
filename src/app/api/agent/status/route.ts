//src\app\api\agent\status\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const scaAddress = searchParams.get('scaAddress');
    const tokenId = searchParams.get('tokenId');
    const name = searchParams.get('name');

    let where: any;

    // Exact-address lookup stays public — this is how the checkout page
    // shows "paid by [agent name]" to an anonymous customer. It's a narrow
    // lookup of one already-known address, not a listing, so it doesn't
    // need merchant auth.
    if (scaAddress && scaAddress.startsWith('0x') && !tokenId && !name) {
      where = { scaAddress: { equals: scaAddress, mode: 'insensitive' } };
    } else {
      // Anything broader (search by name, tokenId, or no filter at all)
      // is a listing operation and requires merchant auth, scoped to
      // that merchant's own agents only.
      const merchant = await resolveMerchant(request);
      if (!merchant) {
        return NextResponse.json(
          { success: false, error: 'Authentication required for agent search/listing.' },
          { status: 401 }
        );
      }
      where = { merchantId: merchant.id };
      if (scaAddress) where.scaAddress = { equals: scaAddress, mode: 'insensitive' };
      if (tokenId) where.tokenId = tokenId;
      if (name) where.name = { contains: name, mode: 'insensitive' };
    }

    const agents = await (prisma as any).agentRegistry.findMany({ where });

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No agent found matching query.' },
        { status: 404 }
      );
    }

    // Process payment history dynamically
    const enriched = await Promise.all(
      agents.map(async (agent: any) => {
        const payments = await prisma.paymentLog.findMany({
          where: {
            OR: [
              { senderEmail: { equals: agent.scaAddress, mode: 'insensitive' } },
              { senderEmail: { contains: 'agent', mode: 'insensitive' } },
            ],
          },
          orderBy: { timestamp: 'desc' },
          take: 5,
        });

        const totalPaid = payments
          .filter((p) => p.status === 'SUCCESS')
          .reduce((sum, p) => sum + p.amount, 0);

        return {
          ...agent,
          recentPayments: payments,
          totalPaid: parseFloat(totalPaid.toFixed(6)),
          paymentCount: payments.length,
        };
      })
    );

    return NextResponse.json({
      success: true,
      agent: enriched[0],
      agents: enriched,
      count: enriched.length,
    });
  } catch (error: any) {
    console.error('Agent status error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}