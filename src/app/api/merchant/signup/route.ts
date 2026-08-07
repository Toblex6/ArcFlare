// src/app/api/merchant/signup/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { generateVerificationCode, sendVerificationEmail } from '@/src/lib/email';
import bcrypt from 'bcryptjs';
import { isAddress } from 'viem';

const CODE_TTL_MINUTES = 10;

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const body = await req.json().catch(() => ({}));
    const { email, businessName, password, walletProvider, externalAddress } = body;

    if (!email || !businessName || !password) {
      return NextResponse.json(
        { success: false, error: 'email, businessName and password are required.' },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { success: false, error: 'Password must be at least 8 characters.' },
        { status: 400 }
      );
    }

    const resolvedWalletType = walletProvider === 'EXTERNAL' ? 'EXTERNAL' : 'CIRCLE';

    if (resolvedWalletType === 'EXTERNAL') {
      if (!externalAddress || !isAddress(externalAddress)) {
        return NextResponse.json(
          { success: false, error: 'A valid wallet address is required for external payouts.' },
          { status: 400 }
        );
      }
    }

    const existing = await (prisma as any).merchant.findUnique({ where: { email } });

    if (existing && existing.verified) {
      return NextResponse.json(
        { success: false, error: 'An account with this email already exists.' },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationCode = generateVerificationCode();
    const verificationCodeExpiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

    const walletFields =
      resolvedWalletType === 'EXTERNAL'
        ? { walletProvider: 'EXTERNAL', walletAddress: externalAddress, circleWalletId: null }
        : { walletProvider: 'CIRCLE', walletAddress: null, circleWalletId: null }; // Circle wallet is created at verification

    const merchant = existing
      ? await (prisma as any).merchant.update({
        where: { email },
        data: { businessName, passwordHash, verificationCode, verificationCodeExpiresAt, ...walletFields },
      })
      : await (prisma as any).merchant.create({
        data: {
          email,
          businessName,
          passwordHash,
          verified: false,
          apiKey: null,
          verificationCode,
          verificationCodeExpiresAt,
          ...walletFields,
        },
      });

    await sendVerificationEmail(email, businessName, verificationCode);

    return NextResponse.json({
      success: true,
      message: 'Verification code sent. Check your email.',
      email: merchant.email,
    });
  } catch (error: any) {
    console.error('Merchant signup error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}