// src/lib/routing/quoter.ts
//
// Server-side quote orchestration for POST /api/payments/quote.
// The client supplies ONLY { reference, payTokenSymbol }. Everything else —
// settlement token, amount, recipient, canonical addresses, pool, reserves,
// math, expiry, hash — is server-determined. Client-supplied rates, outputs,
// minOuts, pools, routes, or token addresses can never reach this path.

import { formatUnits, parseUnits } from 'viem';
import { prisma } from '@/src/lib/prisma';
import { resolveCurrency, resolveRowCurrency } from '@/src/lib/tokens/resolveCurrency';
import {
  ROUTING_OUT_FEE_BUFFER,
  ROUTING_QUOTE_TTL_MS,
  ROUTING_SLIPPAGE_BPS,
  SWAP_POOL_READ_ABI,
  getRoutingConfig,
  getRoutingPublicClient,
  readWithRetry,
  routingError,
} from './canonical';
import { computeQuoteHash, deriveQuoteInput, discountForSlippage, poolQuoteOut } from './quoteMath';

export interface QuoteRequest {
  reference: string;
  payToken: string; // symbol only: 'USDC' | 'EURC' (validated, then resolved canonically)
}

export interface QuoteResult {
  success: true;
  converted: boolean;
  reference: string;
  payToken: { symbol: string; address: string; decimals: number };
  settlementToken: { symbol: string; address: string; decimals: number };
  // Conversion leg (present only when converted === true):
  inputAmount?: string;
  inputAmountDisplay?: string;
  quotedOutputAmount?: string;
  minOutputAmount?: string;
  quoteExpiresAt?: string;
  deadline?: number;
  quoteHash?: string;
  pool?: string;
  router?: string;
  recipient?: string;
  slippageBps?: number;
  idempotencyKey?: string;
  amount?: number;
  merchantSCA?: string;
  message?: string;
}

function tokenView(t: { symbol: string; address: string; decimals: number }) {
  return { symbol: t.symbol, address: t.address, decimals: t.decimals };
}

export async function requestQuote(req: QuoteRequest): Promise<QuoteResult> {
  const reference = req.reference?.trim();
  if (!reference) throw routingError(400, 'reference is required.');

  const paySymbol = req.payToken?.trim().toUpperCase();
  if (paySymbol !== 'USDC' && paySymbol !== 'EURC') {
    throw routingError(400, `Unsupported pay token: "${req.payToken ?? ''}". v1 routes USDC and EURC only.`);
  }

  const payment = await prisma.paymentLog.findUnique({ where: { reference } });
  if (!payment) throw routingError(404, 'Payment reference not found.');
  if (payment.status === 'SUCCESS') {
    throw routingError(409, 'Payment is already settled — no quote needed.');
  }
  if (payment.expiresAt && new Date() > payment.expiresAt) {
    throw routingError(400, 'Payment reference has expired.');
  }

  // Settlement token Y is authoritative from the frozen invoice row.
  let settlement: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
  try {
    settlement = resolveRowCurrency({
      currency: (payment as any).currency ?? null,
      tokenAddress: (payment as any).tokenAddress ?? null,
    });
  } catch (e: any) {
    throw routingError(400, `Unsupported settlement token for this payment: ${e.message}`);
  }

  const payToken = resolveCurrency({ currency: paySymbol });
  const recipient = (payment as any).merchantSCA as string | null;
  if (!recipient || !recipient.startsWith('0x')) {
    throw routingError(400, 'This payment has no recipient wallet on file.');
  }

  // ── Same-token path: no conversion, direct payment flow stays available ──
  if (payToken.address.toLowerCase() === settlement.address.toLowerCase()) {
    const live = await (prisma as any).paymentConversion.findFirst({
      where: { paymentLogId: payment.id, status: 'QUOTED' },
    });
    if (live) {
      // Customer switched back to direct pay — the stale conversion can never
      // execute; expire it and clear the pay-in marker.
      await (prisma as any).paymentConversion.update({
        where: { id: live.id },
        data: { status: 'EXPIRED' },
      });
      await prisma.paymentLog.update({
        where: { id: payment.id },
        data: { payTokenAddress: null },
      });
    }
    return {
      success: true,
      converted: false,
      reference,
      payToken: tokenView(payToken),
      settlementToken: tokenView(settlement),
      amount: (payment as any).amount,
      merchantSCA: recipient,
      message: 'Same-token payment — pay the settlement token directly; no conversion needed.',
    };
  }

  const { poolAddress, routerAddress, rpcUrl } = getRoutingConfig();
  const client = getRoutingPublicClient(rpcUrl);

  // ── Existing conversion: replay-safe single-use binding ───────────────────
  const existing = await (prisma as any).paymentConversion.findUnique({
    where: { paymentLogId: payment.id },
  });
  if (existing) {
    if (existing.status === 'EXECUTED') {
      throw routingError(409, 'This payment was already converted — the quote is consumed.');
    }
    if (existing.status === 'QUOTED' && new Date(existing.quoteExpiresAt).getTime() > Date.now()) {
      return conversionToQuote(existing, reference, payToken, settlement, recipient, routerAddress);
    }
    if (existing.status === 'QUOTED') {
      await (prisma as any).paymentConversion.update({
        where: { id: existing.id },
        data: { status: 'EXPIRED' },
      });
    }
    // EXPIRED rows stay as history; a fresh row replaces them below. The
    // paymentLogId unique slot is freed by deleting the expired row — one
    // live conversion per payment, always.
    await (prisma as any).paymentConversion.deleteMany({
      where: { paymentLogId: payment.id, status: 'EXPIRED' },
    });
  }

  // ── Live pool state (server-read, retried) ────────────────────────────────
  const poolTokenA = (await readWithRetry('tokenA', () =>
    client.readContract({ address: poolAddress as `0x${string}`, abi: SWAP_POOL_READ_ABI, functionName: 'tokenA' })
  )) as string;
  const poolTokenB = (await readWithRetry('tokenB', () =>
    client.readContract({ address: poolAddress as `0x${string}`, abi: SWAP_POOL_READ_ABI, functionName: 'tokenB' })
  )) as string;
  const pairOk =
    (poolTokenA.toLowerCase() === payToken.address.toLowerCase() &&
      poolTokenB.toLowerCase() === settlement.address.toLowerCase()) ||
    (poolTokenB.toLowerCase() === payToken.address.toLowerCase() &&
      poolTokenA.toLowerCase() === settlement.address.toLowerCase());
  if (!pairOk) {
    throw routingError(503, 'Canonical pool does not serve this pair.');
  }
  const inIsA = poolTokenA.toLowerCase() === payToken.address.toLowerCase();
  const reserveA = (await readWithRetry('reserveA', () =>
    client.readContract({ address: poolAddress as `0x${string}`, abi: SWAP_POOL_READ_ABI, functionName: 'reserveA' })
  )) as bigint;
  const reserveB = (await readWithRetry('reserveB', () =>
    client.readContract({ address: poolAddress as `0x${string}`, abi: SWAP_POOL_READ_ABI, functionName: 'reserveB' })
  )) as bigint;
  const reserveIn = inIsA ? reserveA : reserveB;
  const reserveOut = inIsA ? reserveB : reserveA;

  // ── Exact-integer quote ───────────────────────────────────────────────────
  const invoiceAmount = (payment as any).amount as number;
  if (!(invoiceAmount > 0)) throw routingError(400, 'Invoice amount must be positive.');
  const invoiceBase = parseUnits(invoiceAmount.toFixed(settlement.decimals), settlement.decimals);
  const outFeeBuffer = ROUTING_OUT_FEE_BUFFER[settlement.symbol];
  const derived = deriveQuoteInput({
    invoiceAmountY: invoiceBase,
    reserveIn,
    reserveOut,
    slippageBps: ROUTING_SLIPPAGE_BPS,
    outFeeBuffer,
  });

  // Sanity: our off-chain formula must agree with the pool's own view.
  // (Catches a pool-code drift before persisting anything.)
  const onchainQuote = (await readWithRetry('getQuote', () =>
    client.readContract({
      address: poolAddress as `0x${string}`,
      abi: SWAP_POOL_READ_ABI,
      functionName: 'getQuote',
      args: [payToken.address as `0x${string}`, derived.inputAmount],
    })
  )) as bigint;
  if (onchainQuote <= 0n) throw routingError(503, 'Pool returned an empty quote.');
  // Parity gate: our off-chain formula must agree with the pool's own view
  // within 1% (catches pool-code drift before persisting anything).
  const localQuote = poolQuoteOut(derived.inputAmount, reserveIn, reserveOut);
  const drift = localQuote > onchainQuote ? localQuote - onchainQuote : onchainQuote - localQuote;
  if (drift * 10_000n > localQuote * 100n) {
    throw routingError(503, 'Pool quote disagrees with pricing model — re-quote and try again.');
  }
  // Chain truth wins for the persisted quote; the floor must still cover the
  // invoice after the reserve movement between the search and this read.
  const quotedOutput = onchainQuote;
  const minOutput = discountForSlippage(quotedOutput, ROUTING_SLIPPAGE_BPS, outFeeBuffer);
  if (minOutput < invoiceBase) {
    throw routingError(503, 'Pool quote moved against this trade — re-quote and try again.');
  }

  const quoteExpiresAt = new Date(Date.now() + ROUTING_QUOTE_TTL_MS);
  const expiresAtSec = Math.floor(quoteExpiresAt.getTime() / 1000);
  const quoteHash = computeQuoteHash({
    reference,
    inputToken: payToken.address,
    inputAmount: derived.inputAmount,
    outputToken: settlement.address,
    quotedOutput,
    minOutput,
    expiresAtSec,
    poolAddress,
    routerAddress,
  });
  const idempotencyKey = `quote-${payment.id}-${quoteHash.slice(2, 18)}`;

  try {
    const created = await prisma.$transaction(async (tx: any) => {
      await tx.paymentLog.update({
        where: { id: payment.id },
        data: { payTokenAddress: payToken.address },
      });
      return tx.paymentConversion.create({
        data: {
          paymentLogId: payment.id,
          status: 'QUOTED',
          inputTokenAddress: payToken.address,
          inputAmount: derived.inputAmount.toString(),
          outputTokenAddress: settlement.address,
          quotedOutputAmount: quotedOutput.toString(),
          minOutputAmount: minOutput.toString(),
          quoteExpiresAt,
          quoteHash,
          poolAddress,
          idempotencyKey,
        },
      });
    });
    return conversionToQuote(created, reference, payToken, settlement, recipient, routerAddress);
  } catch (e: any) {
    // Concurrent quoter won the race — return the live row (replay-safe).
    if (e?.code === 'P2002') {
      const winner = await (prisma as any).paymentConversion.findUnique({
        where: { paymentLogId: payment.id },
      });
      if (winner && winner.status === 'QUOTED' && new Date(winner.quoteExpiresAt).getTime() > Date.now()) {
        return conversionToQuote(winner, reference, payToken, settlement, recipient, routerAddress);
      }
    }
    throw e;
  }
}

function conversionToQuote(
  row: any,
  reference: string,
  payToken: { symbol: string; address: string; decimals: number },
  settlement: { symbol: string; address: string; decimals: number },
  recipient: string,
  routerAddress: string
): QuoteResult {
  return {
    success: true,
    converted: true,
    reference,
    payToken: tokenView(payToken),
    settlementToken: tokenView(settlement),
    inputAmount: row.inputAmount,
    inputAmountDisplay: formatUnits(BigInt(row.inputAmount), payToken.decimals),
    quotedOutputAmount: row.quotedOutputAmount,
    minOutputAmount: row.minOutputAmount,
    quoteExpiresAt: new Date(row.quoteExpiresAt).toISOString(),
    deadline: Math.floor(new Date(row.quoteExpiresAt).getTime() / 1000),
    quoteHash: row.quoteHash,
    pool: row.poolAddress,
    router: routerAddress,
    recipient,
    slippageBps: ROUTING_SLIPPAGE_BPS,
    idempotencyKey: row.idempotencyKey,
  };
}
