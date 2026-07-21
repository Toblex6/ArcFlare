// src/app/api/merchant/withdraw/route.ts
// Lets a Circle-managed merchant move USDC out of their Circle wallet to
// any external address they control. EXTERNAL-wallet merchants don't need
// this at all — settlements already land directly in a wallet they hold
// the keys to, so there's nothing to "withdraw."
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { jwtVerify } from 'jose';
import { isAddress, parseUnits } from 'viem';
import { createContractTransaction, getWalletBalance } from '@/src/lib/circle/client';
import { erc20TransferAbi, USDC_CONTRACT, USDC_DECIMALS } from '@/src/lib/wallet/erc20';

const JWT_SECRET = new TextEncoder().encode(
    process.env.MERCHANT_JWT_SECRET || 'arcflare-merchant-secret-change-on-mainnet'
);

export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'withdraw');
        if (!allowed) return limitResponse;

        const token = req.cookies.get('merchant_token')?.value;
        if (!token) {
            return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
        }

        const { payload } = await jwtVerify(token, JWT_SECRET);
        const merchantId = payload.merchantId as string;

        const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
        }

        if (merchant.walletType !== 'CIRCLE' || !merchant.circleWalletId || !merchant.walletAddress) {
            return NextResponse.json(
                { success: false, error: 'Withdrawals are only available for Circle-managed payout wallets.' },
                { status: 400 }
            );
        }

        const body = await req.json().catch(() => ({}));
        const { destinationAddress, amount } = body;

        if (!destinationAddress || !isAddress(destinationAddress)) {
            return NextResponse.json({ success: false, error: 'A valid destination address is required.' }, { status: 400 });
        }

        const amountNum = parseFloat(amount);
        if (!amount || isNaN(amountNum) || amountNum <= 0) {
            return NextResponse.json({ success: false, error: 'A valid withdrawal amount is required.' }, { status: 400 });
        }

        // Confirm sufficient balance before attempting the transfer
        const balanceStr = await getWalletBalance(merchant.circleWalletId);
        const balance = parseFloat(balanceStr);
        if (amountNum > balance) {
            return NextResponse.json(
                { success: false, error: `Insufficient balance. Available: ${balance} USDC.` },
                { status: 400 }
            );
        }

        const amountUnits = parseUnits(amount.toString(), USDC_DECIMALS);

        const txHash = await createContractTransaction(
            merchant.walletAddress,
            USDC_CONTRACT,
            'transfer(address,uint256)',
            [destinationAddress, amountUnits.toString()],
            `Merchant withdrawal — ${merchant.businessName}`
        );

        return NextResponse.json({
            success: true,
            txHash,
            explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
            amount: amountNum,
            currency: 'USDC',
            from: merchant.walletAddress,
            to: destinationAddress,
        });
    } catch (error: any) {
        console.error('Merchant withdraw error:', error);
        return NextResponse.json({ success: false, error: 'Withdrawal failed. Please try again.' }, { status: 500 });
    }
}