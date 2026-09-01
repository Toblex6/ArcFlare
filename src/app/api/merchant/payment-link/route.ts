// src/app/api/merchant/payment-link/route.ts
// Authenticated merchants create shareable payment links
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { jwtVerify } from 'jose';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { tryJwtSecret } from '@/src/lib/auth/secrets';

const JWT_SECRET = tryJwtSecret('MERCHANT_JWT_SECRET');

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse;

    const token = req.cookies.get('merchant_token')?.value;
    if (!token || !JWT_SECRET) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const { amount, currency = 'USDC', description, webhookUrl } = body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return NextResponse.json(
        { success: false, error: 'Valid amount is required.' },
        { status: 400 }
      );
    }

    const reference = `arc_ref_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

    if (!merchant.walletAddress) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Your payout wallet is not set up yet. Visit your dashboard to finish wallet setup before creating payment links.',
        },
        { status: 400 }
      );
    }

    // Same gap as the consumer initialize route: this was never set, so
    // merchant links never functionally expired either. 24h default since
    // merchant links are closer to invoices than a quick P2P request.
    const EXPIRY_HOURS = 24;
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60_000);

    await prisma.paymentLog.create({
      data: {
        reference,
        amount: parseFloat(amount),
        currency,
        chain: 'Arc Testnet v1.0',
        senderEmail: 'pending@checkout',
        merchant: merchant.businessName,
        merchantId: merchant.id,
        merchantSCA: merchant.walletAddress,
        status: 'PENDING',
        webhookUrl: webhookUrl || null,
        expiresAt,
      },
    });

    const checkoutUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'https://flarehq.xyz'}/checkout/${reference}`;

    return NextResponse.json({
      success: true,
      reference,
      checkoutUrl,
      amount: parseFloat(amount),
      currency,
      description: description || null,
      merchant: merchant.businessName,
      expiresIn: '24 hours',
    });
  } catch (error: any) {
    console.error('Payment link error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}

// List merchant's payment links
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('merchant_token')?.value;
    if (!token || !JWT_SECRET) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;
    const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    const payments = await prisma.paymentLog.findMany({
      where: { merchant: merchant.businessName },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    const now = Date.now();
    return NextResponse.json({
      success: true,
      links: payments.map((p) => {
        const isExpired =
          p.status === "PENDING" && (p as any).expiresAt != null && now > new Date((p as any).expiresAt).getTime();
        const displayStatus = isExpired ? "EXPIRED" : p.status;
        return {
          reference: p.reference,
          amount: p.amount,
          currency: p.currency,
          status: displayStatus,
          rawStatus: p.status,
          displayStatus,
          isExpired,
          expiresAt: (p as any).expiresAt ?? null,
          checkoutUrl: `${process.env.NEXT_PUBLIC_BASE_URL || 'https://flarehq.xyz'}/checkout/${p.reference}`,
          createdAt: p.timestamp,
        };
      }),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}