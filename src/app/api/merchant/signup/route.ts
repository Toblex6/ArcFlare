// src/app/api/merchant/signup/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { generateVerificationCode, sendVerificationEmail } from '@/src/lib/email';
import bcrypt from 'bcryptjs';

const CODE_TTL_MINUTES = 10;

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const body = await req.json().catch(() => ({}));
    const { email, businessName, password } = body;

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

    const existing = await (prisma as any).merchant.findUnique({ where: { email } });

    // If they already exist AND are verified, block signup as before.
    if (existing && existing.verified) {
      return NextResponse.json(
        { success: false, error: 'An account with this email already exists.' },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationCode = generateVerificationCode();
    const verificationCodeExpiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

    // If an unverified account already exists for this email (e.g. they
    // abandoned signup last time), just update it with a fresh code instead
    // of erroring out.
    const merchant = existing
      ? await (prisma as any).merchant.update({
          where: { email },
          data: { businessName, passwordHash, verificationCode, verificationCodeExpiresAt },
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
