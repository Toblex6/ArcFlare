// src/app/api/merchant/me/route.ts
// Returns current merchant profile + their payments + API key hint
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(
  process.env.MERCHANT_JWT_SECRET || 'arcflare-merchant-secret-change-on-mainnet'
);

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('merchant_token')?.value;
    if (!token) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const merchant = await (prisma as any).merchant.findUnique({
      where: { id: merchantId },
    });

    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    // Get their payments (matched by businessName in merchant field)
    const payments = await prisma.paymentLog.findMany({
      where: { merchant: merchant.businessName },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    const totalVolume = payments
      .filter((p) => p.status === 'SUCCESS')
      .reduce((sum, p) => sum + p.amount, 0);

    const successCount = payments.filter((p) => p.status === 'SUCCESS').length;

    return NextResponse.json({
      success: true,
      merchant: {
        id: merchant.id,
        email: merchant.email,
        businessName: merchant.businessName,
        createdAt: merchant.createdAt,
        walletType: merchant.walletType,
        walletAddress: merchant.walletAddress,
        // Show masked key — full key was shown only at signup
        apiKeyHint: `${merchant.apiKey.slice(0, 16)}...`,
      },
      stats: {
        totalPayments: payments.length,
        successfulPayments: successCount,
        totalVolume: parseFloat(totalVolume.toFixed(4)),
        successRate:
          payments.length > 0 ? parseFloat(((successCount / payments.length) * 100).toFixed(1)) : 0,
      },
      recentPayments: payments.slice(0, 20).map((p) => ({
        reference: p.reference,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        timestamp: p.timestamp,
        checkoutUrl: `https://arcflare-gateway.onrender.com/checkout/${p.reference}`,
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}

// Logout
export async function DELETE(req: NextRequest) {
  const response = NextResponse.json({ success: true, message: 'Logged out.' });
  response.cookies.delete('merchant_token');
  return response;
}
