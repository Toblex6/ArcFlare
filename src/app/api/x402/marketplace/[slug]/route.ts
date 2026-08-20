// src/app/api/x402/marketplace/[slug]/route.ts
// GET   — public detail view (published listings only, unless the owning
//         merchant is asking, in which case drafts are visible too).
// PATCH — update fields / publish / suspend (owning merchant only).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { checkTargetUrlReachable } from '../route';
import { assertSafeTargetUrl } from '@/lib/security/ssrfGuard';

const ALLOWED_STATUSES = ['DRAFT', 'PUBLISHED', 'SUSPENDED'];

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    try {
        const { slug } = await params;
        const listing = await (prisma as any).apiListing.findUnique({ where: { slug } });

        if (!listing) {
            return NextResponse.json({ success: false, error: 'Listing not found.' }, { status: 404 });
        }

        if (listing.status !== 'PUBLISHED') {
            const caller = await resolveMerchant(request);
            const isOwner = caller && caller.id === listing.merchantId;
            if (!isOwner) {
                return NextResponse.json({ success: false, error: 'Listing not found.' }, { status: 404 });
            }
        }

        const { targetUrl, ...publicListing } = listing;
        return NextResponse.json({ success: true, listing: publicListing });
    } catch (error: any) {
        console.error('[Marketplace] Detail error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    try {
        const merchant = await resolveMerchant(request);
        if (!merchant) {
            return NextResponse.json(
                { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
                { status: 401 }
            );
        }

        const { slug } = await params;
        const existing = await (prisma as any).apiListing.findUnique({ where: { slug } });

        if (!existing) {
            return NextResponse.json({ success: false, error: 'Listing not found.' }, { status: 404 });
        }
        if (existing.merchantId !== merchant.id) {
            return NextResponse.json(
                { success: false, error: 'You do not own this listing.' },
                { status: 403 }
            );
        }

        const body = await request.json();
        const data: Record<string, any> = {};

        if (body.name !== undefined) data.name = body.name;
        if (body.description !== undefined) data.description = body.description;
        if (body.categories !== undefined) {
            data.categories = Array.isArray(body.categories) ? body.categories : existing.categories;
        }
        if (body.docsUrl !== undefined) data.docsUrl = body.docsUrl;

        if (body.pricePerRequest !== undefined) {
            if (!/^\$\d+(\.\d+)?$/.test(body.pricePerRequest)) {
                return NextResponse.json(
                    { success: false, error: 'pricePerRequest must look like "$0.01".' },
                    { status: 400 }
                );
            }
            data.pricePerRequest = body.pricePerRequest;
        }

        if (body.targetUrl !== undefined) {
            try {
                new URL(body.targetUrl);
            } catch {
                return NextResponse.json(
                    { success: false, error: 'targetUrl must be a valid, absolute URL.' },
                    { status: 400 }
                );
            }
            const ssrfCheck = await assertSafeTargetUrl(body.targetUrl);
            if (!ssrfCheck.ok) {
                return NextResponse.json(
                    { success: false, error: `targetUrl rejected: ${ssrfCheck.reason}.` },
                    { status: 400 }
                );
            }
            data.targetUrl = body.targetUrl;
        }

        if (body.status !== undefined) {
            if (!ALLOWED_STATUSES.includes(body.status)) {
                return NextResponse.json(
                    { success: false, error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` },
                    { status: 400 }
                );
            }
            if (body.status === 'PUBLISHED') {
                const effectiveTargetUrl = data.targetUrl ?? existing.targetUrl;
                const reachability = await checkTargetUrlReachable(effectiveTargetUrl);
                if (!reachability.ok) {
                    return NextResponse.json(
                        {
                            success: false,
                            error: `Can't publish — targetUrl failed a reachability check: ${reachability.detail} Fix the URL and try again.`,
                        },
                        { status: 422 }
                    );
                }
            }
            data.status = body.status;
        }

        const updated = await (prisma as any).apiListing.update({
            where: { slug },
            data,
        });

        return NextResponse.json({ success: true, listing: updated });
    } catch (error: any) {
        console.error('[Marketplace] Update error:', error);
        return NextResponse.json(
            { success: false, error: 'Internal Server Error', details: error.message },
            { status: 500 }
        );
    }
}
