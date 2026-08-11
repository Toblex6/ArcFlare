// src/app/api/merchant/reset-password/route.ts
import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/ratelimit';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'withdraw');
    if (!allowed) return limitResponse;

    const { email, code, newPassword } = await req.json();
    if (!email || !code || !newPassword) {
      return NextResponse.json(
        { success: false, error: 'email, code, and newPassword are required.' },
        { status: 400 }
      );
    }
    if (newPassword.length < 8) {
      return NextResponse.json(
        { success: false, error: 'Password must be at least 8 characters.' },
        { status: 400 }
      );
    }

    const merchant = await (prisma as any).merchant.findUnique({ where: { email } });

    // Same code/expiry/match check regardless of which part fails, so a
    // caller can't distinguish "wrong email" from "wrong code" by timing
    // or response shape.
    const valid =
      merchant &&
      merchant.resetCode &&
      merchant.resetCode === code &&
      merchant.resetCodeExpiresAt &&
      merchant.resetCodeExpiresAt > new Date();

    if (!valid) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired reset code.' },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await (prisma as any).merchant.update({
      where: { email },
      data: { passwordHash, resetCode: null, resetCodeExpiresAt: null },
    });

    return NextResponse.json({
      success: true,
      message: 'Password updated. You can log in with your new password now.',
    });
  } catch (error: any) {
    console.error('Reset password error:', error);
    return NextResponse.json({ success: false, error: 'Something went wrong.' }, { status: 500 });
  }
}
