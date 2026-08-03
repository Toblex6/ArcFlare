// src/app/api/merchant/wallet/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { jwtVerify } from 'jose';
import { isAddress } from 'viem';
import { createAccountWallet } from '@/src/lib/circle/client';

const JWT_SECRET = new TextEncoder().encode(
    process.env.MERCHANT_JWT_SECRET || 'flarehq-merchant-secret-change-on-mainnet'
);

async function getMerchantFromCookie(req: NextRequest) {
    const token = req.cookies.get('merchant_token')?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;
    return prisma.merchant.findUnique({ where: { id: merchantId } });
}

// GET — current wallet info for the settings page
export async function GET(req: NextRequest) {
    try {
        const merchant = await getMerchantFromCookie(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
        }

        return NextResponse.json({
            success: true,
            wallet: {
                walletType: merchant.walletType,
                walletAddress: merchant.walletAddress,
                circleWalletId: merchant.circleWalletId,
            },
        });
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
    }
}

// PATCH — switch payout wallet type
export async function PATCH(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'withdraw'); // reuse the strict tier — this touches payout routing
        if (!allowed) return limitResponse;

        const merchant = await getMerchantFromCookie(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const { walletType, externalAddress } = body;

        if (walletType !== 'CIRCLE' && walletType !== 'EXTERNAL') {
            return NextResponse.json({ success: false, error: 'walletType must be CIRCLE or EXTERNAL.' }, { status: 400 });
        }

        if (walletType === 'EXTERNAL') {
            if (!externalAddress || !isAddress(externalAddress)) {
                return NextResponse.json({ success: false, error: 'A valid wallet address is required.' }, { status: 400 });
            }

            const updated = await prisma.merchant.update({
                where: { id: merchant.id },
                data: { walletType: 'EXTERNAL', walletAddress: externalAddress, circleWalletId: null },
            });

            return NextResponse.json({
                success: true,
                message: 'Payout wallet switched to your external address. Future payments settle there directly.',
                wallet: { walletType: updated.walletType, walletAddress: updated.walletAddress },
            });
        }

        // Switching TO Circle-managed
        if (merchant.walletType === 'CIRCLE' && merchant.walletAddress) {
            return NextResponse.json({ success: false, error: 'You already have a Circle-managed wallet.' }, { status: 409 });
        }

        // Note: if they previously had a Circle wallet, switched away, and are switching back,
        // this provisions a brand-new Circle wallet rather than restoring the old one — the old
        // wallet ID was overwritten to null when they switched to EXTERNAL, so it's not recoverable
        // through this flow. Flag this to the merchant clearly in the confirmation UI.
        const wallet = await createAccountWallet(merchant.businessName);

        const updated = await prisma.merchant.update({
            where: { id: merchant.id },
            data: { walletType: 'CIRCLE', walletAddress: wallet.address, circleWalletId: wallet.walletId },
        });

        return NextResponse.json({
            success: true,
            message: 'A new Circle-managed wallet has been created for your payouts.',
            wallet: { walletType: updated.walletType, walletAddress: updated.walletAddress },
        });
    } catch (error: any) {
        console.error('Merchant wallet switch error:', error);
        return NextResponse.json({ success: false, error: 'Could not update payout wallet.' }, { status: 500 });
    }
}