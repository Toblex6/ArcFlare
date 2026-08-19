// src/app/api/merchant/forgot-password/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateVerificationCode, sendPasswordResetEmail } from '@/lib/email';
import { checkRateLimit } from '@/lib/ratelimit';

const CODE_TTL_MINUTES = 15;

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'withdraw');
    if (!allowed) return limitResponse;

    const { email } = await req.json();
    if (!email) {
      return NextResponse.json({ success: false, error: 'Email is required.' }, { status: 400 });
    }

    const merchant = await (prisma as any).merchant.findUnique({ where: { email } });

    // Always return success, whether or not the email exists — otherwise
    // this endpoint becomes a way to enumerate registered merchant emails.
    if (merchant) {
      const resetCode = generateVerificationCode();
      const resetCodeExpiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

      await (prisma as any).merchant.update({
        where: { email },
        data: { resetCode, resetCodeExpiresAt, resetCodeAttempts: 0 },
      });

      await sendPasswordResetEmail(email, merchant.businessName, resetCode).catch((e) => {
        console.error('[forgot-password] Email send failed:', e.message);
      });
    }

    return NextResponse.json({
      success: true,
      message: 'If an account exists for that email, a reset code has been sent.',
    });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    return NextResponse.json({ success: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
