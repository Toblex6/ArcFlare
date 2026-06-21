// src/app/api/merchant/signup/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

function generateApiKey(): string {
  return `arc_live_${randomBytes(24).toString('hex')}`;
}

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

    // Check if already registered
    const existing = await (prisma as any).merchant.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'An account with this email already exists.' },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const apiKey = generateApiKey();

    const merchant = await (prisma as any).merchant.create({
      data: {
        email,
        businessName,
        passwordHash,
        apiKey,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Account created successfully.',
      merchant: {
        id: merchant.id,
        email: merchant.email,
        businessName: merchant.businessName,
        createdAt: merchant.createdAt,
      },
      // Show API key ONCE — merchant must save this
      apiKey,
      warning: 'Save your API key now. It will not be shown again.',
    });
  } catch (error: any) {
    console.error('Merchant signup error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
