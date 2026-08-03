// src/app/api/x402/marketplace/pay/[slug]/route.ts
//
// The marketplace's paid entrypoint. Same job as /api/nano/pay/[endpoint],
// except the price + upstream handler come from the ApiListing table instead
// of the hardcoded PRICE_TABLE / RESOURCE_HANDLERS maps in that file.
//
// withGateway() itself is untouched — this route just resolves a listing,
// builds a proxy handler for it, and hands both to the existing gateway.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withGateway } from '@/lib/x402';

// Headers that must not be forwarded upstream (either hop-by-hop, or ours to strip
// so the provider never sees the buyer's x402 payment proof).
const STRIP_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'payment-signature',
]);

async function buildProxyHandler(targetUrl: string) {
    return async (req: NextRequest): Promise<NextResponse> => {
        const upstreamHeaders = new Headers();
        req.headers.forEach((value, key) => {
            if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
                upstreamHeaders.set(key, value);
            }
        });

        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

        let upstreamRes: Response;
        try {
            upstreamRes = await fetch(targetUrl, {
                method: req.method,
                headers: upstreamHeaders,
                body: hasBody ? await req.text() : undefined,
            });
        } catch (err: any) {
            return NextResponse.json(
                { success: false, error: `Upstream provider unreachable: ${err.message}` },
                { status: 502 }
            );
        }

        const bodyText = await upstreamRes.text();
        const responseHeaders = new Headers();
        const contentType = upstreamRes.headers.get('content-type');
        if (contentType) responseHeaders.set('content-type', contentType);

        return new NextResponse(bodyText, {
            status: upstreamRes.status,
            headers: responseHeaders,
        });
    };
}

async function handleRequest(req: NextRequest, slug: string): Promise<NextResponse> {
    const listing = await (prisma as any).apiListing.findUnique({ where: { slug } });

    if (!listing || listing.status !== 'PUBLISHED') {
        return NextResponse.json(
            { success: false, error: `No published API listing found for "${slug}".` },
            { status: 404 }
        );
    }

    const proxyHandler = await buildProxyHandler(listing.targetUrl);

    const protectedHandler = withGateway(
        proxyHandler,
        listing.pricePerRequest,
        `/api/x402/marketplace/pay/${slug}`,
        listing.id,
        listing.merchantId ?? undefined
    );

    return protectedHandler(req);
}

async function route(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    return handleRequest(req, slug);
}

export const GET = route;
export const POST = route;
export const PUT = route;
export const DELETE = route;