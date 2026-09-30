// src/app/api/merchant/login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { requireJwtSecret } from '@/src/lib/auth/secrets';
import {
  ensureMerchantMainnetWallet,
} from '@/src/lib/merchant/walletMigration';
import { WALLET_UPGRADED_MESSAGE } from '@/src/lib/wallets/upgradeGuards';

const JWT_SECRET = requireJwtSecret('MERCHANT_JWT_SECRET');

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const body = await req.json().catch(() => ({}));
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'email and password are required.' },
        { status: 400 }
      );
    }


    const merchant = await (prisma as any).merchant.findUnique({ where: { email } });
    if (!merchant) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password.' },
        { status: 401 }
      );
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return NextResponse.json({ success: false, error: 'Invalid email or password.' }, { status: 401 });
    }

    if (!merchant.verified) {
      return NextResponse.json({ success: false, error: 'Please verify your email first.' }, { status: 403 });
    }

    if (!merchant.active) {
      return NextResponse.json(
        { success: false, error: 'Account is deactivated.' },
        { status: 403 }
      );
    }

    // Returning CIRCLE row: mainnet wallet upgrade check (Step E). Own
    // login only — never bulk, never agents. A clean 404 provisions one
    // fresh ARC wallet (locked + idempotent); transient Circle failures
    // never block login (money paths guide a re-login with a friendly
    // error instead). Healthy, id-less, and non-CIRCLE merchants pass
    // through untouched.
    let merchantRow = merchant;
    if (merchant.walletProvider === 'CIRCLE' && merchant.circleWalletId) {
      try {
        const mig = await ensureMerchantMainnetWallet(merchant.id);
        if (mig.migrated) {
          merchantRow = await (prisma as any).merchant
            .findUnique({ where: { id: merchant.id } })
            .catch(() => merchant);
        }
      } catch (e: any) {
        console.error('[merchant/login] wallet upgrade check failed:', e?.message ?? e);
      }
    }

    // One-time upgrade message: shown once, then cleared (a failed clear
    // only repeats the message next login, never blocks it).
    let walletUpgraded = false;
    if (merchantRow?.migrationNoticePending) {
      walletUpgraded = true;
      await (prisma as any).merchant
        .update({ where: { id: merchantRow.id }, data: { migrationNoticePending: false } })
        .catch(() => {});
    }

    // Issue JWT — 7 day expiry. Carries the account's sessionVersion so the
    // middleware can reject sessions issued before a password reset (M18).
    const token = await new SignJWT({
      merchantId: merchant.id,
      email: merchant.email,
      businessName: merchant.businessName,
      sessionVersion: merchant.sessionVersion ?? 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(JWT_SECRET);

    const response = NextResponse.json({
      success: true,
      ...(walletUpgraded ? { walletUpgraded: true, walletUpgradedMessage: WALLET_UPGRADED_MESSAGE } : {}),
      merchant: {
        id: merchantRow.id,
        email: merchantRow.email,
        businessName: merchantRow.businessName,
        walletAddress: merchantRow.walletAddress ?? null,
      },
    });

    // Set HTTP-only cookie
    response.cookies.set('merchant_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return response;
  } catch (error: any) {
    console.error('Merchant login error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
