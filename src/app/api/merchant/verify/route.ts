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

    // Provision a Circle-managed payout wallet for this merchant.
    // If Circle provisioning fails, we still verify the account — the
    // merchant can retry wallet setup from the dashboard rather than
    // being blocked from signing up entirely.
    let walletFields: {
      walletType: string;
      walletAddress?: string;
      circleWalletId?: string;
    } = { walletType: 'CIRCLE' };

    try {
      const wallet = await createAccountWallet(merchant.id);
      walletFields.walletAddress = wallet.address;
      walletFields.circleWalletId = wallet.walletId;
    } catch (walletError: any) {
      console.error(`Merchant wallet provisioning failed for ${email}:`, walletError.message);
    }

    const updated = await (prisma as any).merchant.update({
      where: { email },
      data: {
        verified: true,
        apiKey,
        verificationCode: null,
        verificationCodeExpiresAt: null,
        ...walletFields,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Account verified successfully.',
      merchant: {
        id: updated.id,
        email: updated.email,
        businessName: updated.businessName,
        createdAt: updated.createdAt,
        walletAddress: updated.walletAddress,
        walletType: updated.walletType,
      },
      apiKey,
      warning: 'Save your API key now. It will not be shown again.',
      walletWarning: !updated.walletAddress
        ? 'Payout wallet setup failed — visit your dashboard to retry before accepting live payments.'
        : undefined,
    });
  } catch (error: any) {
    console.error('Merchant verify error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
