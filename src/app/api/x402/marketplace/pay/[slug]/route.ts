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

        // From here on, the buyer has already paid (this handler only runs after
        // withGateway settles). An upstream problem is the merchant's problem to
        // fix, not a reason to fail the payment transaction at the HTTP layer —
        // so this always returns 200 with a JSON envelope, and the real outcome
        // is embedded in the body. This also fixes the buyer's x402 client
        // crashing on non-JSON/error responses from misconfigured upstreams.
        let upstreamRes: Response;
        try {
            upstreamRes = await fetch(targetUrl, {
                method: req.method,
                headers: upstreamHeaders,
                body: hasBody ? await req.text() : undefined,
                signal: AbortSignal.timeout(15000),
            });
        } catch (err: any) {
            return NextResponse.json({
                paymentStatus: 'settled',
                upstreamOk: false,
                upstreamStatus: null,
                error: `Upstream provider unreachable: ${err.message}`,
                data: null,
            });
        }

        const bodyText = await upstreamRes.text();
        const contentType = upstreamRes.headers.get('content-type') || '';
        let parsedData: unknown = bodyText;
        if (contentType.includes('application/json')) {
            try {
                parsedData = JSON.parse(bodyText);
            } catch {
                // upstream claimed JSON but didn't send valid JSON — fall back to raw text
                parsedData = bodyText;
            }
        }

        return NextResponse.json({
            paymentStatus: 'settled',
            upstreamOk: upstreamRes.ok,
            upstreamStatus: upstreamRes.status,
            error: upstreamRes.ok ? null : `Upstream responded with ${upstreamRes.status}.`,
            data: parsedData,
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
