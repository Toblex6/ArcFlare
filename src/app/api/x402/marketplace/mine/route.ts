// src/app/api/x402/marketplace/mine/route.ts
// Not in the original spec — added because the publish/manage UI needs a
// way for a merchant to see their own DRAFT/SUSPENDED listings too, which
// the public GET /api/x402/marketplace intentionally excludes.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';

export async function GET(request: NextRequest) {
    try {
        const merchant = await resolveMerchant(request);
        if (!merchant) {
            return NextResponse.json(
                { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
                { status: 401 }
            );
        }

        const listings = await (prisma as any).apiListing.findMany({
            where: { merchantId: merchant.id },
            orderBy: { createdAt: 'desc' },
        });

        return NextResponse.json({ success: true, count: listings.length, listings });
    } catch (error: any) {
        console.error('[Marketplace] Mine error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}