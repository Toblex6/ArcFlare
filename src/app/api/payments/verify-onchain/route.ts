// src/app/api/payments/verify-onchain/route.ts
// The customer's wallet submits the USDC transfer directly on-chain —
// FlareHQ never touches those funds. This route is what turns "a
// transaction hash the browser gave us" into "a payment we can trust":
// it independently reads the transaction receipt from the chain and
// confirms a real Transfer(customer -> merchant, >= amount) log exists
// before marking anything SUCCESS. A client claiming success alone is
// never sufficient.
//
// H1 hardening: one direct payment proof (chainId, txHash, logIndex) settles
// AT MOST ONE invoice. The claim row is created atomically inside the same
// transaction as the SUCCESS update (see src/lib/payments/directProof.ts) —
// concurrent verifiers race on the unique constraint and exactly one wins.
// Platform-fee collection is claim-before-transfer exactly-once (see
// src/lib/payments/platformFee.ts) and can never roll back a settled payment.

import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, parseUnits, erc20Abi } from 'viem';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { erc20TransferAbi } from '@/src/lib/wallet/erc20';
import { resolveRowCurrency } from '@/src/lib/tokens/resolveCurrency';
import { getRoutingConfig, readWithRetry } from '@/src/lib/routing/canonical';
import { checkRoutedExecution, findRoutedEvent } from '@/src/lib/routing/verifier';
import { getArcChain, getNetworkConfig } from "@/lib/config/network";
import { claimTxSlot, recheckExecutionConsumerTx, executionConflict } from '@/src/lib/swap/service';
import {
    findDirectTransfer,
    assertTransferNotPredatingInvoice,
    assertMainnetSettlementAllowed,
    settleDirectPaymentAtomic,
} from '@/src/lib/payments/directProof';
import {
    settlePlatformFeeOnce,
    prismaPlatformFeeStore,
    circleFeePorts,
    type FeeDecision,
} from '@/src/lib/payments/platformFee';

void erc20TransferAbi;

/**
 * Chain client for verification — built per request from the single
 * authoritative network config (chain metadata + primary RPC). Never a
 * stale/testnet-pinned chain object: on ARC_NETWORK=mainnet this resolves to
 * Arc Mainnet (chain 5042, mainnet RPC), and misconfiguration fails closed
 * inside getNetworkConfig instead of silently verifying against testnet.
 */
function verifierClient() {
    const cfg = getNetworkConfig();
    return createPublicClient({ chain: getArcChain(), transport: http(cfg.primaryRpc) });
}

async function readTokenBalance(
    owner: string,
    tokenAddress: string
): Promise<bigint> {
    const cfg = getNetworkConfig();
    const pc = createPublicClient({
        chain: getArcChain(),
        transport: http(cfg.primaryRpc),
    });
    return (await pc.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner as `0x${string}`],
    })) as bigint;
}

interface FeeToken {
    symbol: 'USDC' | 'EURC';
    address: string;
    decimals: number;
}

/**
 * Platform-fee collection, best-effort and NEVER load-bearing for the payment
 * result: any failure (or deferral) is logged, never thrown, so a fee
 * operational failure cannot falsely report the customer payment as failed
 * and can never roll back a SUCCESS that already persisted.
 */
async function settleFeeBestEffort(payment: any, token: FeeToken): Promise<void> {
    try {
        const FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS ?? '25', 10);
        const unitsPerToken = 10 ** token.decimals;
        const rawFee = payment.amount * FEE_BPS / 10000;
        const feeAmount = Math.round(rawFee * unitsPerToken) / unitsPerToken;
        const feeRounded = Math.round(feeAmount * unitsPerToken) / unitsPerToken;
        const SELLER_ADDRESS = process.env.SELLER_ADDRESS as string | undefined;

        const merchantRow: any = payment.merchantId
            ? await (prisma as any).merchant.findUnique({ where: { id: payment.merchantId } })
            : null;
        const fallbackMerchantId =
            (payment as any).merchantId || (merchantRow?.id as string | undefined) || 'unknown';

        let decision: FeeDecision;
        if (!merchantRow || merchantRow.walletProvider !== 'CIRCLE' || !merchantRow.circleWalletId) {
            decision = { kind: 'defer', reason: 'non-Circle wallet, cannot auto-debit' };
        } else if (feeRounded === 0) {
            decision = { kind: 'defer', reason: 'fee rounds to zero' };
        } else if (!SELLER_ADDRESS) {
            decision = { kind: 'defer', reason: 'fee collector address not configured' };
        } else {
            let merchantBalance: bigint | null = null;
            try {
                merchantBalance = await readTokenBalance(merchantRow.walletAddress as string, token.address);
            } catch (e: any) {
                console.error('fee balance read failed:', e.message);
            }
            const feeWei = BigInt(Math.round(feeRounded * unitsPerToken));
            if (merchantBalance !== null && merchantBalance < feeWei) {
                decision = { kind: 'defer', reason: 'insufficient balance' };
            } else {
                const amountStr = feeRounded.toFixed(token.decimals).replace(/\.?0+$/, '');
                decision = {
                    kind: 'collect',
                    walletId: merchantRow.circleWalletId as string,
                    walletAddress: merchantRow.walletAddress as string,
                    destinationAddress: SELLER_ADDRESS,
                    amountStr,
                    tokenAddress: token.address,
                    decimals: token.decimals,
                };
            }
        }

        // SELLER delta measurement (informational amountReceived only).
        let sellerBefore = 0n;
        if (decision.kind === 'collect' && SELLER_ADDRESS) {
            try {
                sellerBefore = await readTokenBalance(SELLER_ADDRESS, token.address);
            } catch { /* RPC hiccup — fall back to requested amount */ }
        }
        const outcome = await settlePlatformFeeOnce({
            store: prismaPlatformFeeStore(),
            ports: circleFeePorts(async () => {
                if (!SELLER_ADDRESS) return null;
                try {
                    const sellerAfter = await readTokenBalance(SELLER_ADDRESS, token.address);
                    const delta = sellerAfter - sellerBefore;
                    if (delta > 0n) return Number(delta) / unitsPerToken;
                } catch { /* fall back to requested amount */ }
                return null;
            }),
            paymentLogId: payment.id,
            merchantId: fallbackMerchantId,
            amountCharged: feeAmount,
            decision,
        });
        console.log(`platform fee ${outcome.action} for payment ${payment.reference ?? payment.id}`);
    } catch (e: any) {
        // Fail closed WITHOUT touching the settled payment: fee state says
        // FAILED/PENDING (resumable), the customer payment stays SUCCESS.
        console.error('Platform fee debit error:', e?.message ?? e);
    }
}

export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
        if (!allowed) return limitResponse;

        const body = await req.json().catch(() => ({}));
        const { reference, txHash, wrapTxHash } = body;

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
            // Crash recovery: a fee claim left PENDING by a crashed first
            // attempt resumes here under the SAME idempotency key — never a
            // second transfer. The payment result itself is unchanged.
            try {
                const settledToken = resolveRowCurrency({
                    currency: (payment as any).currency ?? null,
                    tokenAddress: (payment as any).tokenAddress ?? null,
                });
                await settleFeeBestEffort(payment, settledToken);
            } catch { /* fee is best-effort; the payment stays settled */ }
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

        // Mainnet merchant-checkout policy: USDC-only settlement, enforced
        // server-side (the UI restriction alone is bypassable). Testnet keeps
        // its intentionally-supported multicurrency behavior.
        try {
            assertMainnetSettlementAllowed(token.symbol);
        } catch (gateErr: any) {
            return NextResponse.json(
                { success: false, error: gateErr.message },
                { status: typeof gateErr?.status === 'number' ? gateErr.status : 400 }
            );
        }

        if (!payment.merchantSCA) {
            return NextResponse.json(
                { success: false, error: 'This payment has no recipient wallet on file.' },
                { status: 400 }
            );
        }

        const cfg = getNetworkConfig();
        const publicClient = verifierClient();

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

        // Chain binding: the receipt was served by the configured network's
        // RPC (a mainnet RPC cannot serve a testnet receipt), and the mined
        // transaction's own chainId must additionally equal the configured
        // chain. A missing tx body degrades to the RPC binding alone.
        try {
            const tx = await publicClient.getTransaction({ hash: txHash }).catch(() => null);
            const txChainId = tx && typeof (tx as any).chainId === 'number' ? (tx as any).chainId : null;
            if (txChainId !== null && txChainId !== cfg.chainId) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `Transaction is not on the configured Arc network (tx chain ${txChainId}, expected ${cfg.chainId}).`,
                    },
                    { status: 400 }
                );
            }
        } catch { /* RPC hiccup on the tx body — receipt binding stands */ }

        // Amount in the RESOLVED token's decimals (both supported tokens are 6
        // decimals today — still resolved, not hardcoded, because the resolver
        // is the canonical abstraction).
        //
        // ── ROUTED LEG (Payment Routing v1 + UnitFlow branch) ────────────
        // A payment carrying a live conversion quote (payTokenAddress X !=
        // settlement Y) is satisfied ONLY by one real execution on the
        // QUOTED venue — never by a plain ERC-20 transfer. Canonical
        // conversions require a PaymentRouted event from the canonical
        // router proving payer, tokenIn, exact input, settlement tokenOut,
        // canonical pool, frozen merchant recipient, output >= minOut, and
        // execution inside quote validity. UnitFlow conversions are proven
        // by the shared swap service instead (UniversalRouter execute()
        // calldata + recipient balance delta + wrap linkage + payer binding).
        // Direct-transfer matching below is skipped entirely for these rows.
        const payTokenAddr = ((payment as any).payTokenAddress as string | null) ?? null;
        const wantsRoute =
            !!payTokenAddr && payTokenAddr.toLowerCase() !== token.address.toLowerCase();
        let routedCheck: { payer: string; actualInput: string; actualOutput: string } | null = null;
        let routedConversion: any = null;

        let matchedTransfer: { from: string; value: bigint; logIndex?: number } | null = null;

        // UnitFlow settlement (if the service already persisted it — the
        // canonical tail below is skipped in that case).
        let unitFlowSettled: { payment: any; payer: string; actualOutput: string } | null = null;

        if (wantsRoute) {
            routedConversion = await (prisma as any).paymentConversion.findUnique({
                where: { paymentLogId: payment.id },
            });
            if (!routedConversion) {
                return NextResponse.json(
                    {
                        success: false,
                        error: 'This payment requires a conversion quote — request one via POST /api/payments/quote.',
                    },
                    { status: 400 }
                );
            }
            // Sender-hint derivation (existing checkout convention — shared
            // by both venue branches below).
            const senderHint =
                payment.senderEmail?.startsWith('0x') &&
                payment.senderEmail.toLowerCase() !== 'pending@checkout'
                    ? payment.senderEmail
                    : payment.payerSCA?.startsWith('0x')
                      ? payment.payerSCA
                      : null;

            // ── UnitFlow branch (shared swap service) ───────────────────
            // Selected ONLY when the stored conversion was quoted on the
            // UnitFlow venue. Evidence collection, pure verification, wrap
            // linkage, payer binding, and the atomic conversion-EXECUTED +
            // payment-SUCCESS persistence all live in the service; the
            // webhook + fee tail below is shared unchanged.
            if (((routedConversion as any).venueId ?? 'canonical') === 'unitflow-v3') {
                const consumedByUnitFlow = await (prisma as any).paymentConversion
                    .findUnique({ where: { executionTxHash: txHash } })
                    .catch(() => null);
                if (consumedByUnitFlow && consumedByUnitFlow.paymentLogId !== payment.id) {
                    return NextResponse.json(
                        { success: false, error: 'This transaction was already consumed by another payment.' },
                        { status: 409 }
                    );
                }
                const allowUnitFlowResume =
                    !!consumedByUnitFlow && consumedByUnitFlow.paymentLogId === payment.id;
                try {
                    const { verifyCheckoutUnitFlow } = await import('@/src/lib/swap/service');
                    const uf = await verifyCheckoutUnitFlow({
                        payment,
                        conversion: routedConversion,
                        txHash,
                        wrapTxHash: wrapTxHash ?? null,
                        senderHint,
                        allowExecutedResume: allowUnitFlowResume,
                    });
                    unitFlowSettled = { payment: uf.payment, payer: uf.payer, actualOutput: uf.actualOutput };
                    matchedTransfer = { from: uf.payer, value: BigInt(uf.actualOutput) };
                } catch (ufErr: any) {
                    const ufStatus = typeof ufErr?.status === 'number' ? ufErr.status : 500;
                    if (ufStatus === 500) console.error('UnitFlow on-chain verification error:', ufErr);
                    return NextResponse.json(
                        { success: false, error: ufErr.message || 'Verification failed.' },
                        { status: ufStatus }
                    );
                }
            } else {
            const { routerAddress, poolAddress } = getRoutingConfig();
            const event = findRoutedEvent((receipt.logs as any) ?? [], routerAddress);
            if (!event) {
                return NextResponse.json(
                    {
                        success: false,
                        error: 'No routed payment execution found in this transaction. Submit the router execution that pays this invoice.',
                    },
                    { status: 400 }
                );
            }
            // A transaction can settle at most one payment: refuse a tx that
            // another conversion already consumed.
            const consumedBy = await (prisma as any).paymentConversion
                .findUnique({ where: { executionTxHash: txHash } })
                .catch(() => null);
            if (consumedBy && consumedBy.paymentLogId !== payment.id) {
                return NextResponse.json(
                    { success: false, error: 'This transaction was already consumed by another payment.' },
                    { status: 409 }
                );
            }
            const allowResume = !!consumedBy && consumedBy.paymentLogId === payment.id;
            const block = await readWithRetry('block', () =>
                publicClient.getBlock({ blockHash: receipt.blockHash })
            );
            try {
                routedCheck = checkRoutedExecution({
                    event,
                    conversion: routedConversion,
                    settlementAddress: token.address,
                    merchantSCA: payment.merchantSCA,
                    canonicalPool: poolAddress,
                    canonicalRouter: routerAddress,
                    blockTimestampSec: Number(block.timestamp),
                    knownPayer: senderHint,
                    allowExecutedResume: allowResume,
                });
            } catch (routeErr: any) {
                const routeStatus = typeof routeErr?.status === 'number' ? routeErr.status : 400;
                return NextResponse.json(
                    { success: false, error: routeErr.message },
                    { status: routeStatus }
                );
            }
            matchedTransfer = { from: routedCheck.payer, value: BigInt(routedCheck.actualOutput) };
            }
        } else {
        // Direct-transfer matching: only a Transfer log emitted by the
        // resolved token contract can satisfy this invoice: a USDC log never
        // satisfies an EURC invoice and vice versa. Logs from any other
        // contract are ignored (skipped, never matched). The matched
        // logIndex identifies the EXACT proof consumed below — claiming the
        // txHash alone would let one multi-transfer transaction settle
        // several invoices.
        const expectedAmount = parseUnits(payment.amount.toString(), token.decimals);
        matchedTransfer = findDirectTransfer((receipt.logs as any) ?? [], {
            tokenAddress: token.address,
            merchantSCA: payment.merchantSCA,
            expectedAmount,
        });
        } // end direct-transfer matching

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

        // H1 temporal binding (direct path only — routed conversions already
        // bind quote time + expiry): a transfer mined before the invoice
        // existed is unrelated by construction and cannot settle it. The
        // block read failing closed here creates no proof row, so a retry
        // after the RPC recovers is always safe.
        if (!wantsRoute) {
            const directBlock = await publicClient
                .getBlock({ blockHash: receipt.blockHash })
                .catch(() => null);
            if (!directBlock) {
                return NextResponse.json(
                    { success: false, error: 'Could not read execution block — retry shortly.' },
                    { status: 503 }
                );
            }
            try {
                assertTransferNotPredatingInvoice({
                    blockTimestampSec: Number(directBlock.timestamp),
                    invoiceCreatedAt: (payment as any).timestamp,
                });
            } catch (timeErr: any) {
                return NextResponse.json(
                    { success: false, error: timeErr.message },
                    { status: typeof timeErr?.status === 'number' ? timeErr.status : 400 }
                );
            }
        }

        // Preserve canonical token identity (currency + tokenAddress) so an
        // EURC verification is never overwritten with USDC. Idempotency
        // unchanged: SUCCESS rows short-circuit at the top of this handler.
        //
        // Routed settlements additionally flip the conversion to EXECUTED with
        // measured amounts — atomically with the payment SUCCESS update, so a
        // crash between the two is resumable (same-tx resubmission completes
        // the payment instead of double-settling).
        const successData = {
            status: 'SUCCESS',
            arcTxHash: txHash,
            payerSCA: matchedTransfer.from,
            senderEmail: matchedTransfer.from,
            currency: token.symbol,
            tokenAddress: token.address,
        };
        // UnitFlow conversions are already persisted atomically inside the
        // shared swap service (conversion EXECUTED + payment SUCCESS) —
        // reuse that row so the webhook + fee tail below sees one update.
        // Canonical routed conversions are atomically protected inside the
        // transaction below: claimTxSlot + in-transaction cross-table recheck
        // serialize concurrent claimants for the same execution tx hash,
        // and same-record idempotent resume is preserved.
        // Direct transfers are protected the same way via the consumed-proof
        // claim (chainId, txHash, logIndex) — see directProof.ts.
        let updated: any;
        if (unitFlowSettled) {
            updated = unitFlowSettled.payment;
        } else if (routedConversion && routedCheck) {
            try {
                updated = await prisma.$transaction(async (db: any) => {
                    await claimTxSlot(db, txHash);
                    await recheckExecutionConsumerTx(db, txHash, { kind: 'checkout', paymentLogId: payment.id });
                    const live = await db.paymentConversion.findUnique({ where: { id: routedConversion.id } });
                    if (live?.status === 'EXECUTED') {
                        if (live.executionTxHash && live.executionTxHash.toLowerCase() === txHash.toLowerCase()) {
                            return db.paymentLog.findUnique({ where: { reference } });
                        }
                    }
                    await db.paymentConversion.update({
                        where: { id: routedConversion.id },
                        data: {
                            status: 'EXECUTED',
                            executionTxHash: txHash,
                            actualInputAmount: routedCheck.actualInput,
                            actualOutputAmount: routedCheck.actualOutput,
                        },
                    });
                    return db.paymentLog.update({ where: { reference }, data: successData });
                });
            } catch (e: any) {
                throw executionConflict(e);
            }
        } else if (!wantsRoute) {
            // H1: atomic proof-consumption + SUCCESS. Same proof replayed
            // against THIS invoice resumes idempotently; against ANY other
            // invoice it fails 409 — sequentially and concurrently.
            if (matchedTransfer.logIndex === undefined) {
                return NextResponse.json(
                    { success: false, error: 'Transfer proof is missing its log index — refusing.' },
                    { status: 500 }
                );
            }
            try {
                ({ payment: updated } = await settleDirectPaymentAtomic({
                    db: prisma,
                    reference,
                    paymentId: payment.id,
                    chainId: cfg.chainId,
                    txHash,
                    logIndex: matchedTransfer.logIndex,
                    successData,
                }));
            } catch (claimErr: any) {
                const claimStatus = typeof claimErr?.status === 'number' ? claimErr.status : 500;
                if (claimStatus === 500) console.error('Direct proof claim error:', claimErr);
                return NextResponse.json(
                    { success: false, error: claimErr.message || 'Verification failed.' },
                    { status: claimStatus }
                );
            }
        } else {
            updated = await prisma.paymentLog.update({ where: { reference }, data: successData });
        }

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
        // Claim-before-transfer exactly-once (src/lib/payments/platformFee.ts):
        // at most one Circle transfer per settled payment across duplicates,
        // concurrency, and crash-retries. Best-effort: failures are logged,
        // never thrown — the customer payment above stays SUCCESS.
        await settleFeeBestEffort(updated, token);

        return NextResponse.json({ success: true, payment: updated });
    } catch (error: any) {
        console.error('On-chain verification error:', error);
        let status = typeof error?.status === 'number' ? error.status : 500;
        // Pooled-DB burst timeouts never started a transaction (no state
        // changed) — report retryable 503, never a terminal 500.
        if (status === 500 && (error?.code === 'P2028' || error?.code === 'P2034')) {
            status = 503;
        }
        return NextResponse.json(
            { success: false, error: error.message || 'Verification failed.' },
            { status }
        );
    }
}
