// src/app/api/x402/marketplace/route.ts
// POST — publish a new listing (merchant-authed).
// GET  — public discovery: list + filter published listings.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withMerchantAuth, AuthedMerchant } from '@/lib/middleware/withMerchantAuth';
import { assertSafeTargetUrl } from '@/lib/security/ssrfGuard';

function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

/**
 * Lightweight reachability check — does NOT guarantee the endpoint will
 * behave correctly under real traffic, but catches the obvious "typo'd URL"
 * / "endpoint doesn't exist" class of mistake before it can ever charge a
 * buyer. Called at publish time, not creation time, since DRAFT listings
 * aren't payable yet.
 */
export async function checkTargetUrlReachable(targetUrl: string): Promise<{ ok: boolean; detail: string }> {
    try {
        const ssrfCheck = await assertSafeTargetUrl(targetUrl);
        if (!ssrfCheck.ok) {
            return { ok: false, detail: `targetUrl rejected by SSRF guard: ${ssrfCheck.reason}.` };
        }
        const res = await fetch(targetUrl, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
        if (res.status === 405) {
            // Some APIs reject HEAD but are otherwise fine — not a reason to block publishing.
            return { ok: true, detail: 'Target does not support HEAD, skipped strict check.' };
        }
        if (res.status >= 500) {
            return { ok: false, detail: `Target responded with server error ${res.status}.` };
        }
        return { ok: true, detail: `Reachable (${res.status}).` };
    } catch (err: any) {
        return { ok: false, detail: `Target is unreachable: ${err.message}` };
    }
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
            // Agent listing fields (optional)
            agentRegistryId,
            listingType = "service", // "service" | "agent"
        } = await request.json();

        // Validate based on listing type
        if (listingType === "agent") {
            // Agent listing: requires agentRegistryId, no targetUrl required
            if (!agentRegistryId) {
                return NextResponse.json(
                    { success: false, error: 'agentRegistryId is required for agent listings' },
                    { status: 400 }
                );
            }
            // Verify agent exists and belongs to this merchant
            const agent = await (prisma as any).agentRegistry.findUnique({
                where: { id: agentRegistryId },
                select: { id: true, merchantId: true, status: true, scaAddress: true },
            });
            if (!agent) {
                return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
            }
            if (agent.merchantId !== merchant.id) {
                return NextResponse.json(
                    { error: 'You can only list agents you own' },
                    { status: 403 }
                );
            }
            if (agent.status !== "ACTIVE_AGENT_PROVISIONED") {
                return NextResponse.json(
                    { error: 'Agent must be ACTIVE_AGENT_PROVISIONED to be listed' },
                    { status: 400 }
                );
            }
        } else {
            // Service listing (default): requires targetUrl
            if (!name || !pricePerRequest || !targetUrl) {
                return NextResponse.json(
                    { success: false, error: 'name, pricePerRequest, and targetUrl are required for service listings.' },
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

            const ssrfCheck = await assertSafeTargetUrl(targetUrl);
            if (!ssrfCheck.ok) {
                return NextResponse.json(
                    { success: false, error: `targetUrl rejected: ${ssrfCheck.reason}.` },
                    { status: 400 }
                );
            }
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
                pricePerRequest: listingType === "service" ? pricePerRequest : (pricePerRequest || "$0.00"),
                docsUrl: docsUrl || null,
                targetUrl: listingType === "service" ? targetUrl : (targetUrl || "https://agent.internal/hire"),
                status: 'DRAFT',
                merchantId: merchant.id,
                agentRegistryId: listingType === "agent" ? agentRegistryId : null,
            },
        });

        return NextResponse.json(
            {
                success: true,
                listing,
                payEndpoint: listingType === "service" ? `/api/x402/marketplace/pay/${slug}` : null,
                hireEndpoint: listingType === "agent" ? `/api/agents/${listing.agentRegistryId}/hire` : null,
                cardEndpoint: listingType === "agent" ? `/api/agents/${listing.agentRegistryId}/card` : null,
                message: listingType === "agent"
                    ? `Agent listing created as a draft. Check "My Listings" to publish it and make it live.`
                    : `Listing created as a draft. Check "My Listings" to publish it and make it live.`,
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
        const listingType = searchParams.get('type'); // "service" | "agent" | undefined (both)

        const where: any = { status: 'PUBLISHED' };
        if (listingType === "service") {
            where.agentRegistryId = null;
        } else if (listingType === "agent") {
            where.agentRegistryId = { not: null };
        }
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
                targetUrl: true,
                status: true,
                merchantId: true,
                agentRegistryId: true,
                createdAt: true,
            },
        });

        // Enrich agent listings with agent data
        const enriched = await Promise.all(
            listings.map(async (listing: any) => {
                if (listing.agentRegistryId) {
                    const agent = await (prisma as any).agentRegistry.findUnique({
                        where: { id: listing.agentRegistryId },
                        select: {
                            id: true,
                            tokenId: true,
                            scaAddress: true,
                            name: true,
                            status: true,
                            reputation: true,
                            skills: true,
                            pricing: true,
                        },
                    });
                    return {
                        ...listing,
                        type: "agent",
                        agent: agent ? {
                            id: agent.id,
                            tokenId: agent.tokenId,
                            scaAddress: agent.scaAddress,
                            name: agent.name,
                            status: agent.status,
                            reputation: agent.reputation ?? 50,
                            skills: agent.skills ?? [],
                            pricing: agent.pricing ?? {},
                            cardUrl: `/api/agents/${agent.id}/card`,
                            hireUrl: `/api/agents/${agent.id}/hire`,
                        } : null,
                        hireUrl: `/api/agents/${listing.agentRegistryId}/hire`,
                        cardUrl: `/api/agents/${listing.agentRegistryId}/card`,
                    };
                }
                return {
                    ...listing,
                    type: "service",
                    payEndpoint: `/api/x402/marketplace/pay/${listing.slug}`,
                };
            })
        );

        return NextResponse.json({ success: true, count: listings.length, listings: enriched });
    } catch (error: any) {
        console.error('[Marketplace] List error:', error);
        return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
    }
}
