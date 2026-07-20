// src/app/api/payments/verify-onchain/route.ts
// The customer's wallet submits the USDC transfer directly on-chain —
// ArcFlare never touches those funds. This route is what turns "a
// transaction hash the browser gave us" into "a payment we can trust":
// it independently reads the transaction receipt from the chain and
// confirms a real Transfer(customer -> merchant, >= amount) log exists
// before marking anything SUCCESS. A client claiming success alone is
// never sufficient.

import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, parseUnits, decodeEventLog } from 'viem';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { arcTestnet } from '@/src/lib/wagmi';
import { USDC_CONTRACT, USDC_DECIMALS, erc20TransferAbi } from '@/src/lib/wallet/erc20';

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
});

export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
        if (!allowed) return limitResponse;

        const body = await req.json().catch(() => ({}));
        const { reference, txHash } = body;

        if (!reference || !txHash) {
            return NextResponse.json(
                { success: false, error: 'reference and txHash are required.' },
                { status: 400 }
            );
        }

        const payment = await prisma.paymentLog.findUnique({ where: { reference } });
        if (!payment) {
            return NextResponse.json({ success: false, error: 'Payment not found.' }, { status: 404 });
        }
        if (payment.status === 'SUCCESS') {
            return NextResponse.json({ success: true, alreadySettled: true });
        }
        if (!payment.merchantSCA) {
            return NextResponse.json(
                { success: false, error: 'This payment has no recipient wallet on file.' },
                { status: 400 }
            );
        }

        // Read the receipt directly from the chain — do not trust anything
        // the client says about whether the tx "worked."
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

        if (receipt.status !== 'success') {
            await prisma.paymentLog.update({
                where: { reference },
                data: { status: 'FAILED', arcTxHash: txHash },
            });
            return NextResponse.json(
                { success: false, error: 'Transaction reverted on-chain.' },
                { status: 400 }
            );
        }

        const expectedAmount = parseUnits(payment.amount.toString(), USDC_DECIMALS);
        const merchantAddr = payment.merchantSCA.toLowerCase();

        let matchedTransfer: { from: string; value: bigint } | null = null;

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
            try {
                const decoded = decodeEventLog({
                    abi: erc20TransferAbi,
                    data: log.data,
                    topics: log.topics,
                });
                if (decoded.eventName !== 'Transfer') continue;
                const { to, from, value } = decoded.args as unknown as {
                    to: string;
                    from: string;
                    value: bigint;
                };
                if (to.toLowerCase() === merchantAddr && value >= expectedAmount) {
                    matchedTransfer = { from, value };
                    break;
                }
            } catch {
                continue; // not a Transfer log, skip
            }
        }

        if (!matchedTransfer) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        'No matching USDC transfer to the merchant wallet found in this transaction. Payment not confirmed.',
                },
                { status: 400 }
            );
        }

        const updated = await prisma.paymentLog.update({
            where: { reference },
            data: {
                status: 'SUCCESS',
                arcTxHash: txHash,
                payerSCA: matchedTransfer.from,
                senderEmail: matchedTransfer.from,
            },
        });

        if (updated.webhookUrl) {
            fetch(updated.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'payment.settled',
                    reference: updated.reference,
                    amount: updated.amount,
                    currency: updated.currency,
                    status: 'SUCCESS',
                    txHash,
                    settledAt: new Date().toISOString(),
                }),
            }).catch((err) => console.error('Webhook delivery failed:', err.message));
        }

        return NextResponse.json({ success: true, payment: updated });
    } catch (error: any) {
        console.error('On-chain verification error:', error);
        return NextResponse.json(
            { success: false, error: error.message || 'Verification failed.' },
            { status: 500 }
        );
    }
}