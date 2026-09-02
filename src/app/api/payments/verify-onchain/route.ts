// src/app/api/payments/verify-onchain/route.ts
// The customer's wallet submits the USDC transfer directly on-chain —
// FlareHQ never touches those funds. This route is what turns "a
// transaction hash the browser gave us" into "a payment we can trust":
// it independently reads the transaction receipt from the chain and
// confirms a real Transfer(customer -> merchant, >= amount) log exists
// before marking anything SUCCESS. A client claiming success alone is
// never sufficient.

import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, parseUnits, decodeEventLog, erc20Abi } from 'viem';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { arcTestnet } from '@/src/lib/wagmi';
import { USDC_CONTRACT, USDC_DECIMALS, erc20TransferAbi } from '@/src/lib/wallet/erc20';
import { transferUsdc } from '@/src/lib/circle/transfers';

const USDC_ARC = '0x3600000000000000000000000000000000000000';

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

        // ── Platform fee debit (post-SUCCESS, never touches customer->merchant verification) ──
        try {
            const FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS ?? '100', 10);
            const rawFee = payment.amount * FEE_BPS / 10000;
            const feeAmount = Math.round(rawFee * 1_000_000) / 1_000_000;
            const feeRounded = Math.round(feeAmount * 1e6) / 1e6;
            const SELLER_ADDRESS = process.env.SELLER_ADDRESS as string | undefined;

            async function readUsdcBalance(owner: string): Promise<bigint> {
                const pc = createPublicClient({
                    chain: arcTestnet,
                    transport: http(process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network'),
                });
                return (await pc.readContract({
                    address: USDC_ARC as `0x${string}`,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [owner as `0x${string}`],
                })) as bigint;
            }

            const merchantRow: any = payment.merchantId
                ? await (prisma as any).merchant.findUnique({ where: { id: payment.merchantId } })
                : null;

            const fallbackMerchantId = (payment as any).merchantId || (merchantRow?.id as string | undefined) || 'unknown';

            // Non-Circle wallet — cannot auto-debit
            if (!merchantRow || merchantRow.walletProvider !== 'CIRCLE' || !merchantRow.circleWalletId) {
                console.log('fee skipped — non-Circle wallet, cannot auto-debit');
                try {
                    await (prisma as any).platformFee.create({
                        data: {
                            paymentLogId: payment.id,
                            merchantId: fallbackMerchantId,
                            amountCharged: feeAmount,
                            status: 'DEFERRED',
                            deferredReason: 'non-Circle wallet, cannot auto-debit',
                        },
                    });
                } catch (e: any) {
                    console.error('PlatformFee DEFERRED create failed (non-Circle):', e.message);
                }
            } else if (feeRounded === 0) {
                console.log('fee skipped — fee rounds to zero');
                try {
                    await (prisma as any).platformFee.create({
                        data: {
                            paymentLogId: payment.id,
                            merchantId: fallbackMerchantId,
                            amountCharged: feeAmount,
                            status: 'DEFERRED',
                            deferredReason: 'fee rounds to zero',
                        },
                    });
                } catch (e: any) {
                    console.error('PlatformFee DEFERRED create failed (rounds to zero):', e.message);
                }
            } else if (!SELLER_ADDRESS) {
                console.log('fee skipped — non-Circle wallet, cannot auto-debit');
                try {
                    await (prisma as any).platformFee.create({
                        data: {
                            paymentLogId: payment.id,
                            merchantId: fallbackMerchantId,
                            amountCharged: feeAmount,
                            status: 'DEFERRED',
                            deferredReason: 'non-Circle wallet, cannot auto-debit',
                        },
                    });
                } catch (e: any) {
                    console.error('PlatformFee DEFERRED create failed (no SELLER_ADDRESS):', e.message);
                }
            } else {
                // Check merchant Circle wallet balance before attempting debit
                let merchantBalance: bigint | null = null;
                try {
                    merchantBalance = await readUsdcBalance(merchantRow.walletAddress as string);
                } catch (e: any) {
                    console.error('fee balance read failed:', e.message);
                }
                const feeWei = BigInt(Math.round(feeRounded * 1_000_000));
                if (merchantBalance !== null && merchantBalance < feeWei) {
                    console.log('fee skipped — insufficient balance');
                    try {
                        await (prisma as any).platformFee.create({
                            data: {
                                paymentLogId: payment.id,
                                merchantId: fallbackMerchantId,
                                amountCharged: feeAmount,
                                status: 'DEFERRED',
                                deferredReason: 'insufficient balance',
                            },
                        });
                    } catch (e: any) {
                        console.error('PlatformFee DEFERRED create failed (insufficient balance):', e.message);
                    }
                } else {
                    // Attempt fee debit via Circle SDK, measure SELLER delta
                    const amountStr = feeRounded.toFixed(6).replace(/\.?0+$/, '');
                    let sellerBefore = 0n;
                    try {
                        sellerBefore = await readUsdcBalance(SELLER_ADDRESS);
                    } catch {}
                    let arcTxHashFee: string | undefined;
                    let feeTransferFailed = false;
                    try {
                        const result = await transferUsdc({
                            walletId: merchantRow.circleWalletId as string,
                            walletAddress: merchantRow.walletAddress as string,
                            destinationAddress: SELLER_ADDRESS,
                            amount: amountStr,
                        });
                        arcTxHashFee = result.arcTxHash;
                    } catch (e: any) {
                        console.error('Platform fee transfer failed:', e.message);
                        try {
                            await (prisma as any).platformFee.create({
                                data: {
                                    paymentLogId: payment.id,
                                    merchantId: fallbackMerchantId,
                                    amountCharged: feeAmount,
                                    status: 'FAILED',
                                    deferredReason: e.message?.slice(0, 500),
                                },
                            });
                        } catch (inner: any) {
                            console.error('PlatformFee FAILED create failed:', inner.message);
                        }
                        // Do not rethrow — fee failure must not affect SUCCESS response
                        feeTransferFailed = true;
                    }
                    if (!feeTransferFailed && arcTxHashFee) {
                        let receivedWei = feeWei;
                        let amountReceived: number = feeRounded;
                        try {
                            const sellerAfter = await readUsdcBalance(SELLER_ADDRESS);
                            const delta = sellerAfter - sellerBefore;
                            if (delta > 0n) {
                                receivedWei = delta;
                                amountReceived = Number(delta) / 1e6;
                            }
                        } catch {
                            // RPC hiccup — fall back to requested amount
                        }
                        try {
                            await (prisma as any).platformFee.create({
                                data: {
                                    paymentLogId: payment.id,
                                    merchantId: fallbackMerchantId,
                                    amountCharged: feeAmount,
                                    amountReceived,
                                    status: 'SUCCESS',
                                    txHash: arcTxHashFee,
                                },
                            });
                        } catch (e: any) {
                            console.error('PlatformFee SUCCESS create failed:', e.message);
                        }
                    }
                }
            }
        } catch (e: any) {
            console.error('Platform fee debit error:', e.message);
            try {
                const FEE_BPS_FALLBACK = parseInt(process.env.PLATFORM_FEE_BPS ?? '100', 10);
                const feeFallback = Math.round((payment.amount * FEE_BPS_FALLBACK / 10000) * 1e6) / 1e6;
                await (prisma as any).platformFee.create({
                    data: {
                        paymentLogId: payment.id,
                        merchantId: (payment as any).merchantId || 'unknown',
                        amountCharged: feeFallback,
                        status: 'FAILED',
                        deferredReason: e.message?.slice(0, 500),
                    },
                });
            } catch (inner: any) {
                console.error('PlatformFee FAILED outer create failed:', inner.message);
            }
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