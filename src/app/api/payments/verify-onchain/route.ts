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
import { erc20TransferAbi } from '@/src/lib/wallet/erc20';
import { resolveRowCurrency } from '@/src/lib/tokens/resolveCurrency';
import { transferUsdc } from '@/src/lib/circle/transfers';

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

        // ── PHASE 2A CANONICAL TOKEN RESOLUTION ───────────────────────────────
        // The invoice/payment token is authoritative: resolve currency +
        // tokenAddress through the canonical resolver (legacy NULL
        // tokenAddress → USDC). Unsupported symbols/addresses and
        // symbol/address mismatches are rejected here — never guessed, never
        // converted. The resolved token drives Transfer-log matching,
        // decimals, and the fee leg below.
        let token: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
        try {
            token = resolveRowCurrency({
                currency: (payment as any).currency ?? null,
                tokenAddress: (payment as any).tokenAddress ?? null,
            });
        } catch (tokenErr: any) {
            return NextResponse.json(
                {
                    success: false,
                    error: `Unsupported settlement token for this payment: ${tokenErr.message}`,
                },
                { status: 400 }
            );
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

        // Amount in the RESOLVED token's decimals (both supported tokens are 6
        // decimals today — still resolved, not hardcoded, because the resolver
        // is the canonical abstraction). Only a Transfer log emitted by the
        // resolved token contract can satisfy this invoice: a USDC log never
        // satisfies an EURC invoice and vice versa. Logs from any other
        // contract are ignored (skipped, never matched).
        const expectedAmount = parseUnits(payment.amount.toString(), token.decimals);
        const merchantAddr = payment.merchantSCA.toLowerCase();

        let matchedTransfer: { from: string; value: bigint } | null = null;

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== token.address.toLowerCase()) continue;
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
                        `No matching ${token.symbol} transfer to the merchant wallet found in this transaction. Payment not confirmed.`,
                },
                { status: 400 }
            );
        }

        // Preserve canonical token identity (currency + tokenAddress) so an
        // EURC verification is never overwritten with USDC. Idempotency
        // unchanged: SUCCESS rows short-circuit at the top of this handler.
        const updated = await prisma.paymentLog.update({
            where: { reference },
            data: {
                status: 'SUCCESS',
                arcTxHash: txHash,
                payerSCA: matchedTransfer.from,
                senderEmail: matchedTransfer.from,
                currency: token.symbol,
                tokenAddress: token.address,
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
        // FEE SEMANTICS (Phase 2A): the existing protocol charges FEE_BPS of the
        // invoice amount in TOKEN UNITS — that math is token-unit based, so it
        // applies identically in USDC or EURC with no cross-currency assumption
        // (1 EURC is never treated as 1 USDC; the fee is denominated in the
        // invoice's own token). Balance reads and the debit transfer therefore
        // use the resolved token contract, not a hardcoded USDC address.
        try {
            const FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS ?? '25', 10);
            const unitsPerToken = 10 ** token.decimals;
            const rawFee = payment.amount * FEE_BPS / 10000;
            const feeAmount = Math.round(rawFee * unitsPerToken) / unitsPerToken;
            const feeRounded = Math.round(feeAmount * unitsPerToken) / unitsPerToken;
            const SELLER_ADDRESS = process.env.SELLER_ADDRESS as string | undefined;

            async function readTokenBalance(owner: string): Promise<bigint> {
                const pc = createPublicClient({
                    chain: arcTestnet,
                    transport: http(process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network'),
                });
                return (await pc.readContract({
                    address: token.address as `0x${string}`,
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
                    merchantBalance = await readTokenBalance(merchantRow.walletAddress as string);
                } catch (e: any) {
                    console.error('fee balance read failed:', e.message);
                }
                const feeWei = BigInt(Math.round(feeRounded * unitsPerToken));
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
                    // Attempt fee debit via Circle SDK in the invoice's token,
                    // measure SELLER delta
                    const amountStr = feeRounded.toFixed(token.decimals).replace(/\.?0+$/, '');
                    let sellerBefore = 0n;
                    try {
                        sellerBefore = await readTokenBalance(SELLER_ADDRESS);
                    } catch {}
                    let arcTxHashFee: string | undefined;
                    let feeTransferFailed = false;
                    try {
                        const result = await transferUsdc({
                            walletId: merchantRow.circleWalletId as string,
                            walletAddress: merchantRow.walletAddress as string,
                            destinationAddress: SELLER_ADDRESS,
                            amount: amountStr,
                            tokenAddress: token.address,
                            decimals: token.decimals,
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
                            const sellerAfter = await readTokenBalance(SELLER_ADDRESS);
                            const delta = sellerAfter - sellerBefore;
                            if (delta > 0n) {
                                receivedWei = delta;
                                amountReceived = Number(delta) / unitsPerToken;
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
                const FEE_BPS_FALLBACK = parseInt(process.env.PLATFORM_FEE_BPS ?? '25', 10);
                const fallbackUnits = 10 ** token.decimals;
                const feeFallback = Math.round((payment.amount * FEE_BPS_FALLBACK / 10000) * fallbackUnits) / fallbackUnits;
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