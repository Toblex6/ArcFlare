// src/app/api/consumer/session/route.ts
// Wallet-first consumer auth — no email/password. A wallet address IS the
// account. Session is a signed JWT cookie, same pattern as merchant auth
// but with no credentials to check — possession of the address is enough
// for a testnet consumer product. (Real fund custody still lives in Circle
// for CIRCLE-type wallets; EXTERNAL wallets are non-custodial by nature.)

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { SignJWT, jwtVerify } from 'jose';
import { isAddress } from 'viem';
import { createAccountWallet } from '@/src/lib/circle/client';

const JWT_SECRET = new TextEncoder().encode(
    process.env.CONSUMER_JWT_SECRET || 'flarehq-consumer-secret-change-on-mainnet'
);

async function issueSession(account: { id: string; walletAddress: string }) {
    const token = await new SignJWT({
        consumerId: account.id,
        walletAddress: account.walletAddress,
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(JWT_SECRET);

    const response = NextResponse.json({
        success: true,
        account: { id: account.id, walletAddress: account.walletAddress },
    });

    response.cookies.set('consumer_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days — consumers shouldn't have to re-onboard often
        path: '/',
    });

    return response;
}

// POST /api/consumer/session
// body: {} -> create a brand new Circle-managed wallet + account
// body: { walletAddress } -> connect an existing external wallet
export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
        if (!allowed) return limitResponse;

        const body = await req.json().catch(() => ({}));
        const { walletAddress } = body;

        // ── Path A: connect an existing wallet ──────────────────────────────
        if (walletAddress) {
            if (!isAddress(walletAddress)) {
                return NextResponse.json(
                    { success: false, error: 'Not a valid wallet address.' },
                    { status: 400 }
                );
            }

            let account = await (prisma as any).consumerAccount.findUnique({
                where: { walletAddress },
            });

            if (!account) {
                account = await (prisma as any).consumerAccount.create({
                    data: { walletAddress, walletType: 'EXTERNAL' },
                });
            } else {
                await (prisma as any).consumerAccount.update({
                    where: { id: account.id },
                    data: { lastSeenAt: new Date() },
                });
            }

            return issueSession(account);
        }

        // ── Path B: create a brand new Circle-managed wallet ────────────────
        const wallet = await createAccountWallet(`consumer_${Date.now()}`);

        const account = await (prisma as any).consumerAccount.create({
            data: {
                walletAddress: wallet.address,
                walletType: 'CIRCLE',
                circleWalletId: wallet.walletId,
                walletSetId: wallet.walletSetId,
            },
        });

        return issueSession(account);
    } catch (error: any) {
        console.error('Consumer session error:', error);
        return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
    }
}

// GET /api/consumer/session — check for an existing session (used on page load)
export async function GET(req: NextRequest) {
    try {
        const token = req.cookies.get('consumer_token')?.value;
        if (!token) {
            return NextResponse.json({ success: false, error: 'No session.' }, { status: 401 });
        }

        const { payload } = await jwtVerify(token, JWT_SECRET);
        return NextResponse.json({
            success: true,
            account: {
                id: payload.consumerId as string,
                walletAddress: payload.walletAddress as string,
            },
        });
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid or expired session.' }, { status: 401 });
    }
}

// DELETE /api/consumer/session — sign out
export async function DELETE() {
    const response = NextResponse.json({ success: true });
    response.cookies.delete('consumer_token');
    return response;
}