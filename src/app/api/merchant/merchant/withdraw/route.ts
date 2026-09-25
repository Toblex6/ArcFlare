// src/app/api/merchant/withdraw/route.ts
// Lets a Circle-managed merchant move USDC out of their Circle wallet to
// any external address they control. EXTERNAL-wallet merchants don't need
// this at all — settlements already land directly in a wallet they hold
// the keys to, so there's nothing to "withdraw."
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { isAddress, parseUnits } from 'viem';
import { createContractTransaction, getWalletBalance } from '@/src/lib/circle/client';
import { erc20TransferAbi, USDC_CONTRACT, USDC_DECIMALS } from '@/src/lib/wallet/erc20';
import { explorerTxUrl } from "@/lib/config/network";

// H5: central merchant auth (active + verified + sessionVersion). H6:
// Idempotency-Key dedupe via PaymentLog.idempotencyKey (unique) — the claim
// row is created BEFORE the on-chain transfer so a retry can never
// double-spend; replays return the bound txHash.

export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'withdraw');
        if (!allowed) return limitResponse;

        const authed = await resolveMerchant(req);
        if (!authed) {
            return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
        }

        const merchant = await (prisma as any).merchant.findUnique({ where: { id: authed.id } });
        if (!merchant) {
            return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
        }

        // H6: mandatory server idempotency key.
        const rawKey = req.headers.get('idempotency-key')?.trim();
        if (!rawKey || rawKey.length > 120) {
            return NextResponse.json(
                { success: false, error: 'Idempotency-Key header (1-120 chars) is required.' },
                { status: 400 }
            );
        }
        const idempotencyKey = `merchant-withdraw:${merchant.id}:${rawKey}`;
        const existing = await prisma.paymentLog.findUnique({ where: { idempotencyKey } }).catch(() => null);
        if (existing) {
            if ((existing as any).merchantId && (existing as any).merchantId !== merchant.id) {
                return NextResponse.json({ success: false, error: 'Idempotency key already in use.' }, { status: 409 });
            }
            return NextResponse.json({
                success: (existing as any).status === 'SUCCESS',
                replayed: true,
                txHash: (existing as any).arcTxHash ?? null,
                explorerUrl: (existing as any).arcTxHash ? explorerTxUrl((existing as any).arcTxHash) : null,
                amount: (existing as any).amount,
                currency: 'USDC',
            });
        }

        if (merchant.walletProvider !== 'CIRCLE' || !merchant.circleWalletId || !merchant.walletAddress) {
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

        // H6: claim BEFORE the on-chain write. Concurrent retries with the
        // same key race here; the loser gets P2002 and replays the winner.
        const claimRef = `withdraw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            await prisma.paymentLog.create({
                data: {
                    reference: claimRef,
                    idempotencyKey,
                    amount: amountNum,
                    currency: 'USDC',
                    chain: 'Arc Testnet v1.0',
                    senderEmail: merchant.email ?? 'merchant@withdraw',
                    merchant: merchant.businessName,
                    merchantId: merchant.id,
                    merchantSCA: merchant.walletAddress,
                    status: 'PROCESSING',
                },
            });
        } catch (e: any) {
            if (e?.code === 'P2002') {
                const winner = await prisma.paymentLog.findUnique({ where: { idempotencyKey } }).catch(() => null);
                return NextResponse.json({
                    success: (winner as any)?.status === 'SUCCESS',
                    replayed: true,
                    txHash: (winner as any)?.arcTxHash ?? null,
                    amount: (winner as any)?.amount ?? amountNum,
                    currency: 'USDC',
                });
            }
            throw e;
        }

        const txHash = await createContractTransaction(
            merchant.walletAddress,
            USDC_CONTRACT,
            'transfer(address,uint256)',
            [destinationAddress, amountUnits.toString()],
            `Merchant withdrawal — ${merchant.businessName}`
        );

        await prisma.paymentLog.update({
            where: { idempotencyKey },
            data: { status: 'SUCCESS', arcTxHash: txHash },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            txHash,
            explorerUrl: `${explorerTxUrl(txHash)}`,
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