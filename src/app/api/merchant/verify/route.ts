// src/app/api/merchant/verify/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { randomBytes } from 'crypto';
import { createAccountWallet } from '@/src/lib/circle/client';

function generateApiKey(): string {
  return `arc_live_${randomBytes(24).toString('hex')}`;
}

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const body = await req.json().catch(() => ({}));
    const { email, code } = body;

    if (!email || !code) {
      return NextResponse.json(
        { success: false, error: 'email and code are required.' },
        { status: 400 }
      );
    }

    const merchant = await (prisma as any).merchant.findUnique({ where: { email } });

    if (!merchant) {
      return NextResponse.json({ success: false, error: 'No account found for this email.' }, { status: 404 });
    }

    if (merchant.verified) {
      return NextResponse.json({ success: false, error: 'This account is already verified.' }, { status: 409 });
    }

    if (!merchant.verificationCode || merchant.verificationCode !== code) {
      return NextResponse.json({ success: false, error: 'Invalid verification code.' }, { status: 400 });
    }

    if (!merchant.verificationCodeExpiresAt || merchant.verificationCodeExpiresAt < new Date()) {
      return NextResponse.json(
        { success: false, error: 'Verification code has expired. Please sign up again to get a new one.' },
        { status: 400 }
      );
    }

    const apiKey = generateApiKey();

    // Provision the payout wallet now — only for merchants who chose Circle-managed.
    // EXTERNAL merchants already have their walletAddress set at signup, nothing to do.
    let walletUpdate: { walletAddress?: string; circleWalletId?: string } = {};
    if (merchant.walletProvider === 'CIRCLE') {
      try {
        const wallet = await createAccountWallet(merchant.businessName);
        walletUpdate = { walletAddress: wallet.address, circleWalletId: wallet.walletId };
      } catch (walletErr: any) {
        console.error('Merchant wallet provisioning failed:', walletErr);
        return NextResponse.json(
          { success: false, error: 'Verification succeeded but wallet setup failed. Please contact support.' },
          { status: 500 }
        );
      }
    }

    const updated = await (prisma as any).merchant.update({
      where: { email },
      data: {
        verified: true,
        apiKey,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        ...walletUpdate,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Account verified successfully.',
      merchant: {
        id: updated.id,
        email: updated.email,
        businessName: updated.businessName,
        walletProvider: updated.walletProvider,
        walletAddress: updated.walletAddress,
        createdAt: updated.createdAt,
      },
      apiKey,
      warning: 'Save your API key now. It will not be shown again.',
    });
  } catch (error: any) {
    console.error('Merchant verify error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}