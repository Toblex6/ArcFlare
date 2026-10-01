// src/app/api/merchant/wallet/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { isAddress } from 'viem';
import { createAccountWallet } from '@/src/lib/circle/client';
import { getArcNetworkName } from '@/src/lib/config/network';
import {
  WALLET_CHECK_FAILED_CODE,
  WALLET_CHECK_RETRY_MESSAGE,
  WALLET_NEEDS_UPDATE_MESSAGE,
  checkCircleWalletLiveness,
} from '@/src/lib/wallets/liveness';

// H5: central merchant auth (active + verified + sessionVersion).
async function getMerchantFromCookie(req: NextRequest) {
    const authed = await resolveMerchant(req);
    if (!authed) return null;
    return prisma.merchant.findUnique({ where: { id: authed.id } });
}

// GET — current wallet info for the settings page
export async function GET(req: NextRequest) {
    try {
        const merchant = await getMerchantFromCookie(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
        }

        // Mainnet display gate: a CIRCLE payout address that is not ARC+LIVE
        // under the production key must never be shown (deposit target).
        // Hide it and force the re-login repair path — login runs the
        // existing merchant login-time migration. Testnet: never gated.
        let walletVerified = false;
        if (
            getArcNetworkName() === 'mainnet' &&
            merchant.walletProvider === 'CIRCLE' &&
            merchant.circleWalletId
        ) {
            const live = await checkCircleWalletLiveness(merchant.circleWalletId, merchant.walletAddress);
            if (live.checked && !live.live) {
                // Transient: retry, address withheld. Stale: re-login.
                if (!live.stale) {
                    return NextResponse.json(
                        { success: false, code: WALLET_CHECK_FAILED_CODE, error: WALLET_CHECK_RETRY_MESSAGE },
                        { status: 503 }
                    );
                }
                return NextResponse.json(
                    { success: false, code: 'WALLET_NEEDS_UPDATE', error: WALLET_NEEDS_UPDATE_MESSAGE },
                    { status: 409 }
                );
            }
            walletVerified = live.checked && live.live;
        }

        return NextResponse.json({
            success: true,
            wallet: {
                walletProvider: merchant.walletProvider,
                walletAddress: merchant.walletAddress,
                circleWalletId: merchant.circleWalletId,
                walletVerified,
            },
        });
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
    }
}

// PATCH — switch payout wallet type
// SECURITY: previously allowed setting walletProvider: 'EXTERNAL' with a
// bare, unverified address — no proof of ownership. That's exactly what
// the SIWE flow in /api/merchant/wallet/connect exists to replace. This
// route now only handles switching back TO Circle (which needs no
// ownership proof of anything external); switching to an external wallet
// must go through /connect.
export async function PATCH(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'withdraw'); // reuse the strict tier — this touches payout routing
        if (!allowed) return limitResponse;

        const merchant = await getMerchantFromCookie(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const { walletProvider } = body;

        if (walletProvider !== 'CIRCLE') {
            return NextResponse.json(
                {
                    success: false,
                    error: 'This endpoint only switches back to a Circle-managed wallet. To connect an external wallet (MetaMask, WalletConnect, Coinbase), use GET/POST /api/merchant/wallet/connect — it requires signing a message to prove ownership.',
                },
                { status: 400 }
            );
        }

        // Switching TO Circle-managed
        if (merchant.walletProvider === 'CIRCLE' && merchant.walletAddress) {
            return NextResponse.json({ success: false, error: 'You already have a Circle-managed wallet.' }, { status: 409 });
        }

        // Note: if they previously had a Circle wallet, switched away, and are switching back,
        // this provisions a brand-new Circle wallet rather than restoring the old one — the old
        // wallet ID was overwritten to null when they switched away, so it's not recoverable
        // through this flow. Flag this to the merchant clearly in the confirmation UI.
        const wallet = await createAccountWallet(merchant.businessName);

        const updated = await prisma.merchant.update({
            where: { id: merchant.id },
            data: { walletProvider: 'CIRCLE', walletAddress: wallet.address, circleWalletId: wallet.walletId },
        });

        return NextResponse.json({
            success: true,
            message: 'A new Circle-managed wallet has been created for your payouts.',
            wallet: { walletProvider: updated.walletProvider, walletAddress: updated.walletAddress },
        });
    } catch (error: any) {
        console.error('Merchant wallet switch error:', error);
        return NextResponse.json({ success: false, error: 'Could not update payout wallet.' }, { status: 500 });
    }
}