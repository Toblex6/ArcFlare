// src/app/api/merchant/resend-code/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { generateVerificationCode, sendVerificationEmail } from '@/src/lib/email';

const CODE_TTL_MINUTES = 10;

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const { email } = await req.json().catch(() => ({}));
    if (!email) {
      return NextResponse.json({ success: false, error: 'email is required.' }, { status: 400 });
    }

    const merchant = await (prisma as any).merchant.findUnique({ where: { email } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'No account found for this email.' }, { status: 404 });
    }
    if (merchant.verified) {
      return NextResponse.json({ success: false, error: 'This account is already verified.' }, { status: 409 });
    }

    const verificationCode = generateVerificationCode();
    const verificationCodeExpiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

    await (prisma as any).merchant.update({
      where: { email },
      data: { verificationCode, verificationCodeExpiresAt },
    });

    await sendVerificationEmail(email, merchant.businessName, verificationCode);

    return NextResponse.json({ success: true, message: 'A new code has been sent.' });
  } catch (error: any) {
    console.error('Merchant resend-code error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
