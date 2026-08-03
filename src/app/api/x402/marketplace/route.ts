// src/app/api/x402/marketplace/route.ts
// POST — publish a new listing (merchant-authed).
// GET  — public discovery: list + filter published listings.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withMerchantAuth, AuthedMerchant } from '@/lib/middleware/withMerchantAuth';

function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

async function createListingHandler(request: Request, merchant: AuthedMerchant) {
    try {
        const {
            name,
            description,
            categories = [],
            pricePerRequest, // e.g. "$0.01" — same format withGateway already expects
            docsUrl,
            targetUrl, // the provider's real upstream API this listing proxies to
            slug: requestedSlug,
        } = await request.json();

        if (!name || !pricePerRequest || !targetUrl) {
            return NextResponse.json(
                { success: false, error: 'name, pricePerRequest, and targetUrl are required.' },
                { status: 400 }
            );
        }

        if (!/^\$\d+(\.\d+)?$/.test(pricePerRequest)) {
            return NextResponse.json(
                { success: false, error: 'pricePerRequest must look like "$0.01" (matches withGateway\'s expected format).' },
                { status: 400 }
            );
        }

        try {
            new URL(targetUrl);
        } catch {
            return NextResponse.json(
                { success: false, error: 'targetUrl must be a valid, absolute URL.' },
                { status: 400 }
            );
        }

        const baseSlug = slugify(requestedSlug || name);
        if (!baseSlug) {
            return NextResponse.json(
                { success: false, error: 'Could not derive a valid slug from name.' },
                { status: 400 }
            );
        }

        // Ensure uniqueness — append a short suffix on collision rather than erroring,
        // since two providers may reasonably pick the same API name.
        let slug = baseSlug;
        let attempt = 0;
        while (await (prisma as any).apiListing.findUnique({ where: { slug } })) {
            attempt += 1;
            slug = `${baseSlug}-${attempt + 1}`;
        }

        const listing = await (prisma as any).apiListing.create({
            data: {
                slug,
                name,
                description: description || null,
                categories: Array.isArray(categories) ? categories : [],
                pricePerRequest,
                docsUrl: docsUrl || null,
                targetUrl,
                status: 'DRAFT',
                merchantId: merchant.id,
            },
        });

        return NextResponse.json(
            {
                success: true,
                listing,
                payEndpoint: `/api/x402/marketplace/pay/${slug}`,
                message: `Listing created as a draft. Check "My Listings" to publish it and make it live.`,
            },
            { status: 201 }
        );
    } catch (error: any) {
        console.error('[Marketplace] Create listing error:', error);
        return NextResponse.json(
            { success: false, error: 'Internal Server Error', details: error.message },
            { status: 500 }
        );
    }
}

export const POST = withMerchantAuth(createListingHandler as any);

// ── GET /api/x402/marketplace — public discovery ─────────────────────────
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const category = searchParams.get('category');
        const provider = searchParams.get('provider'); // merchantId
        const search = searchParams.get('search');

        const where: any = { status: 'PUBLISHED' };
        if (category) where.categories = { has: category };
        if (provider) where.merchantId = provider;
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
            ];
        }

        const listings = await (prisma as any).apiListing.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                slug: true,
                name: true,
                description: true,
                categories: true,
                pricePerRequest: true,
                docsUrl: true,
                merchantId: true,
                createdAt: true,
                // targetUrl intentionally excluded from public listing — buyers pay
                // through /api/x402/marketplace/pay/[slug]; they don't need the
                // upstream address, and providers may not want it public.
            },
        });

        return NextResponse.json({ success: true, count: listings.length, listings });
    } catch (error: any) {
        console.error('[Marketplace] List error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}