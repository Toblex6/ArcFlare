// src/app/api/checkout/qr/route.ts
// Generates a QR code PNG for a checkout link. GET so it can be dropped
// straight into an <img src="/api/checkout/qr?reference=..."> tag.
//
// Uses NEXT_PUBLIC_BASE_URL — same env var payment-link/route.ts uses to
// build checkoutUrl — so the QR code always encodes the exact same domain
// shown in the copy-link text next to it. (Was previously reading a
// different var, NEXT_PUBLIC_APP_URL, which could point at a different
// fallback domain if only one of the two was actually set.)
//
// Requires: npm install qrcode @types/qrcode

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import QRCode from 'qrcode';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const reference = searchParams.get('reference');

    if (!reference) {
        return NextResponse.json({ success: false, error: 'reference query param is required.' }, { status: 400 });
    }

    // Confirm the reference actually exists before generating a code for it —
    // avoids QR-generating for arbitrary/typo'd references.
    const payment = await prisma.paymentLog.findUnique({ where: { reference }, select: { reference: true } });
    if (!payment) {
        return NextResponse.json({ success: false, error: 'Payment reference not found.' }, { status: 404 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://flarehq.xyz';
    const checkoutUrl = `${baseUrl}/checkout/${reference}`;

    const pngBuffer = await QRCode.toBuffer(checkoutUrl, {
        type: 'png',
        width: 400,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' },
    });

    return new NextResponse(pngBuffer, {
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600',
        },
    });
}