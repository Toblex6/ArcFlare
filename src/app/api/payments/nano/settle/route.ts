// src/app/api/payments/nano/settle/route_C.ts
// 📦 MERGED NANO SETTLEMENT ROUTE
// Combines On-chain token movement with robust validation and rate limiting.
//
// PHASE 2C MULTICURRENCY: settlement batches by agent + merchant + TOKEN, never
// by payer/merchant alone. Each transfer moves exactly the token its rows are
// denominated in (resolved through the canonical resolver; historical NULL
// tokenAddress rows resolve to USDC). USDC rows can never be combined into an
// EURC transfer. No SwapPool is involved — the row's token IS the transfer's
// token. PaymentLog rows persist currency + tokenAddress.

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { prisma } from '@/src/lib/prisma';
import { withApiKeyOrMerchant } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { checkRateLimit } from '@/lib/ratelimit';
import { parseBody, NanoSettleSchema } from '@/lib/validation';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  getUnsettledPairs,
  getBatchSummary,
  resolveNanoToken,
  NANO_BATCH_THRESHOLD_USDC,
} from '@/src/lib/nanopayment';
import { resolveCurrency } from '@/lib/tokens/resolveCurrency';
import type { CurrencyRef } from '@/lib/tokens/resolveCurrency';

// ── Constants & Types ────────────────────────────────────────────────────────
const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';

class CircleTxFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircleTxFailedError';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(client: any, txId: string) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash)
      return data.transaction.txHash;

    if (data?.transaction?.state === 'FAILED') {
      throw new CircleTxFailedError(`Circle tx failed: ${data.transaction.errorReason}`);
    }
  }
  throw new Error('Circle transaction timed out.');
}

async function fireWebhook(url: string, payload: object) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.error('Webhook delivery failed:', err.message);
  }
}

/** True when a PaymentLog/nano row resolves to the settlement token (NULL → USDC). */
function logMatchesToken(log: { currency?: string | null; tokenAddress?: string | null }, token: CurrencyRef): boolean {
  try {
    return resolveNanoToken(log).address.toLowerCase() === token.address.toLowerCase();
  } catch {
    return false;
  }
}

// ── Core On-chain Logic ──────────────────────────────────────────────────────

async function recoverStaleLocks(agentSCA: string, merchantSCA: string, token: CurrencyRef) {
  // Token-scoped: only PENDING lock rows for THIS token are reaped, and only
  // rows resolving to this token are released — an EURC settlement never
  // touches USDC locks (or vice versa).
  const staleLogs = await prisma.paymentLog.findMany({
    where: {
      status: 'PENDING',
      senderEmail: 'nano-batch-system',
      agentSCA,
      merchant: merchantSCA,
      timestamp: { lt: new Date(Date.now() - 5 * 60 * 1000) },
    },
  });

  for (const stale of staleLogs) {
    if (!logMatchesToken(stale as any, token)) continue;
    const locked = await prisma.nanoPayment.findMany({
      where: { batchRef: stale.reference, agentSCA, merchantSCA, settled: false },
      select: { id: true, currency: true, tokenAddress: true },
    });
    const ids = locked.filter((n) => logMatchesToken(n as any, token)).map((n) => n.id);
    await prisma.$transaction(async (tx) => {
      if (ids.length > 0) {
        await tx.nanoPayment.updateMany({
          where: { id: { in: ids } },
          data: { batchRef: null },
        });
      }
      await tx.paymentLog.update({
        where: { id: stale.id },
        data: { status: 'EXPIRED' },
      });
    });
  }
}

async function resumeExistingTransaction(agentSCA: string, merchantSCA: string, token: CurrencyRef) {
  const candidates = await prisma.paymentLog.findMany({
    where: {
      agentSCA,
      merchant: merchantSCA,
      status: 'SUBMITTED',
      senderEmail: 'nano-batch-system',
    },
    orderBy: {
      timestamp: 'asc',
    },
  });
  const existingLog = candidates.find((l) => logMatchesToken(l as any, token));

  if (existingLog?.circleTxId) {
    const circleClient = getCircleClient();
    try {
      const txHash = await waitForCircleTx(circleClient, existingLog.circleTxId);

      const locked = await prisma.nanoPayment.findMany({
        where: {
          batchRef: existingLog.reference,
          agentSCA,
          merchantSCA,
          settled: false,
        },
        select: { id: true, currency: true, tokenAddress: true },
      });
      const ids = locked.filter((n) => logMatchesToken(n as any, token)).map((n) => n.id);

      await prisma.$transaction(async (tx) => {
        if (ids.length > 0) {
          await tx.nanoPayment.updateMany({
            where: { id: { in: ids } },
            data: { settled: true },
          });
        }

        await tx.paymentLog.updateMany({
          where: { id: existingLog.id, status: 'SUBMITTED' },
          data: { status: 'SETTLED', arcTxHash: txHash },
        });
      });

      return {
        batchRef: existingLog.reference,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        resumed: true,
        total: existingLog.amount,
        count: 0,
        currency: token.symbol,
        tokenAddress: token.address,
      };
    } catch (error: any) {
      if (error.name === 'CircleTxFailedError') {
        const locked = await prisma.nanoPayment.findMany({
          where: { batchRef: existingLog.reference, agentSCA, merchantSCA, settled: false },
          select: { id: true, currency: true, tokenAddress: true },
        });
        const ids = locked.filter((n) => logMatchesToken(n as any, token)).map((n) => n.id);
        await prisma.$transaction(async (tx) => {
          if (ids.length > 0) {
            await tx.nanoPayment.updateMany({
              where: { id: { in: ids } },
              data: { batchRef: null },
            });
          }
          await tx.paymentLog.update({
            where: { id: existingLog.id },
            data: { status: 'FAILED' },
          });
        });
      }
      throw error;
    }
  }
  return null;
}

async function settleOnchain(
  agentSCA: string,
  merchantSCA: string,
  token: CurrencyRef,
  webhookUrl?: string,
  isInternalServiceCall = false
) {
  await recoverStaleLocks(agentSCA, merchantSCA, token);

  const resumedTx = await resumeExistingTransaction(agentSCA, merchantSCA, token);
  if (resumedTx) return resumedTx;

  const circleClient = getCircleClient();

  // ── SECURITY (C1-class): the payer wallet is EXPLICITLY resolved, never
  // defaulted. The previous `let payerWalletId = DEFAULT_PAYER_WALLET_ID`
  // assignment-default silently debited the shared platform wallet whenever
  // the caller's agentSCA equalled the default payer SCA — an attacker who
  // controlled only merchantSCA could drain the platform wallet in one
  // force-settled batch. Now:
  //   • the platform default wallet is reachable ONLY from the platform's
  //     internal service key, and only for the default payer SCA itself
  //     (compared case-insensitively — scaAddress preserves casing, and
  //     mixed-case variants of the default address must not bypass);
  //   • every other payer resolves through AgentRegistry (case-insensitive
  //     scaAddress lookup) with NO fallback — a payer without a registered
  //     Circle wallet fails closed instead of inheriting the default.
  const agentSCANormalized = agentSCA.toLowerCase();
  const isPlatformDefaultPayer =
    agentSCANormalized === DEFAULT_PAYER_SCA.toLowerCase();

  let payerWalletId: string | null = null;
  if (isPlatformDefaultPayer) {
    if (!isInternalServiceCall) {
      throw new Error(
        `CRITICAL: refusing to debit the shared platform default wallet for payer ${agentSCA} — only the platform's internal service key may settle for the default payer.`
      );
    }
    payerWalletId = DEFAULT_PAYER_WALLET_ID;
  } else {
    const agentRecord = await prisma.agentRegistry.findFirst({
      where: { scaAddress: { equals: agentSCA, mode: "insensitive" } },
    });
    if (!agentRecord?.circleWalletId) {
      throw new Error(`CRITICAL: No Circle wallet registered for agent SCA ${agentSCA}`);
    }
    payerWalletId = agentRecord.circleWalletId;
  }

  const batchRef = `nano_${randomUUID()}`;

  // Token-scoped atomic claim: only unsettled rows resolving to THIS token
  // are locked under the batchRef. USDC and EURC rows for the same pair are
  // never claimed together, so one transfer can never carry both.
  const { total, count, lockedIds } = await prisma.$transaction(async (tx) => {
    const candidates = await tx.nanoPayment.findMany({
      where: { agentSCA, merchantSCA, settled: false, batchRef: null },
      select: { id: true, amount: true, currency: true, tokenAddress: true },
    });
    const scoped = candidates.filter((n) => logMatchesToken(n as any, token));
    const ids = scoped.map((n) => n.id);
    if (ids.length > 0) {
      await tx.nanoPayment.updateMany({
        where: { id: { in: ids } },
        data: { batchRef },
      });
    }

    const lockedRows = ids.length > 0
      ? await tx.nanoPayment.findMany({
          where: { id: { in: ids } },
        })
      : [];

    // Wrong-token rejection (defense in depth): every locked row MUST resolve
    // to the settlement token. Anything else aborts the batch before any
    // PaymentLog or transfer exists.
    const alien = lockedRows.filter((n) => !logMatchesToken(n as any, token));
    if (alien.length > 0) {
      throw new Error(
        `refusing to settle: ${alien.length} locked row(s) are not ${token.symbol} — release and retry per token`
      );
    }

    const lockedTotal = lockedRows.reduce((sum, n) => sum + n.amount, 0);

    if (lockedRows.length > 0) {
      await tx.paymentLog.create({
        data: {
          reference: batchRef,
          amount: lockedTotal,
          currency: token.symbol,
          tokenAddress: token.address,
          chain: 'ARC-TESTNET',
          senderEmail: 'nano-batch-system',
          merchant: merchantSCA,
          agentSCA: agentSCA,
          status: 'PENDING',
        },
      });
    }

    return { total: lockedTotal, count: lockedRows.length, lockedIds: ids };
  });

  if (count === 0 || total <= 0) {
    throw new Error(`No pending ${token.symbol} payments found or already settling.`);
  }

  // Decimals come from the canonical resolver — never assumed. Both
  // supported tokens use 6 today, but the math must follow the token.
  const amountStr = total.toFixed(token.decimals);
  const amountScaled = Math.floor(total * 10 ** token.decimals).toString();
  let transferTx;

  try {
    transferTx = await circleClient.createTransaction({
      walletId: payerWalletId,
      blockchain: 'ARC-TESTNET',
      tokenAddress: token.address,
      destinationAddress: merchantSCA,
      amounts: [amountStr],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);
  } catch (nativeError: any) {
    transferTx = await circleClient.createContractExecutionTransaction({
      walletId: payerWalletId,
      blockchain: 'ARC-TESTNET',
      contractAddress: token.address,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [merchantSCA, amountScaled],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);
  }

  if (!transferTx?.data?.id) {
    await prisma.$transaction(async (tx) => {
      await tx.nanoPayment.updateMany({
        where: { id: { in: lockedIds } },
        data: { batchRef: null },
      });
      await tx.paymentLog.updateMany({
        where: { reference: batchRef },
        data: { status: 'FAILED' },
      });
    });
    throw new Error('Circle transfer failed to initiate on both native and ERC20 routes.');
  }

  await prisma.paymentLog.updateMany({
    where: { reference: batchRef },
    data: {
      status: 'SUBMITTED',
      circleTxId: transferTx.data.id,
    },
  });

  try {
    const txHash = await waitForCircleTx(circleClient, transferTx.data.id);
    const explorerUrl = `https://testnet.arcscan.app/tx/${txHash}`;

    await prisma.$transaction(async (tx) => {
      await tx.nanoPayment.updateMany({
        where: { id: { in: lockedIds } },
        data: { settled: true },
      });
      await tx.paymentLog.updateMany({
        where: { reference: batchRef },
        data: { status: 'SETTLED', arcTxHash: txHash },
      });
    });

    if (webhookUrl) {
      await fireWebhook(webhookUrl, {
        event: 'nano.batch_settled',
        batchRef,
        agentSCA,
        merchantSCA,
        currency: token.symbol,
        tokenAddress: token.address,
        totalSettled: total,
        paymentsCount: count,
        txHash,
        explorerUrl,
        settledAt: new Date().toISOString(),
      });
    }

    return { batchRef, txHash, explorerUrl, total, count, resumed: false, currency: token.symbol, tokenAddress: token.address };
  } catch (error: any) {
    if (error.name === 'CircleTxFailedError') {
      await prisma.$transaction(async (tx) => {
        await tx.nanoPayment.updateMany({
          where: { id: { in: lockedIds } },
          data: { batchRef: null },
        });
        await tx.paymentLog.updateMany({
          where: { reference: batchRef },
          data: { status: 'FAILED' },
        });
      });
    }
    throw error;
  }
}

// ── Main Handler ─────────────────────────────────────────────────────────────

async function mergedNanoSettleHandler(request: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(request, 'nano');
    if (!allowed) return limitResponse;

    // NOTE: NanoSettleSchema (src/lib/validation.ts) is intentionally NOT
    // extended — validation files are frozen. The token identity rides as
    // optional raw-body fields (currency/tokenAddress) resolved through the
    // canonical resolver below; zod strips them from `data`, so they are
    // read from the raw body BEFORE parseBody.
    const rawBody = await request.json().catch(() => ({}));
    let requestedToken: CurrencyRef | null = null;
    if (rawBody?.currency != null || rawBody?.tokenAddress != null) {
      try {
        requestedToken = resolveCurrency({ currency: rawBody.currency, tokenAddress: rawBody.tokenAddress });
      } catch (tokenError: any) {
        return NextResponse.json({ success: false, error: tokenError.message }, { status: 400 });
      }
    }

    const { data, error: validationError } = parseBody(NanoSettleSchema, rawBody);
    if (validationError) return validationError;

    const { agentSCA, merchantSCA, webhookUrl, forceSettle, autoSettle } = data;

    // ── SECURITY: neither path previously verified the caller controls
    // agentSCA or merchantSCA. autoSettle processes ALL unsettled pairs
    // platform-wide — that's legitimate for trusted internal automation
    // (cron/service key) but not for an arbitrary merchant's API key, so
    // it's now restricted to internal service-key calls only. The explicit
    // single-pair path gets an ownership check instead, since a specific
    // caller is naming a specific pair.
    const internalApiKey = request.headers.get('x-api-key');
    const isInternalServiceCall = internalApiKey
      ? !!(await (prisma as any).apiKey.findUnique({ where: { key: internalApiKey } }))
      : false;

    if (autoSettle) {
      if (!isInternalServiceCall) {
        return NextResponse.json(
          { success: false, error: 'autoSettle requires an internal service API key.' },
          { status: 403 }
        );
      }
      // Token-aware pairs: one entry per agent + merchant + TOKEN, so each
      // on-chain transfer carries exactly one token.
      const pairs = await getUnsettledPairs();
      const scopedPairs = requestedToken
        ? pairs.filter((p) => p.tokenAddress.toLowerCase() === requestedToken!.address.toLowerCase())
        : pairs;
      const results = [];

      for (const pair of scopedPairs) {
        const pairToken = resolveCurrency({ currency: pair.currency, tokenAddress: pair.tokenAddress });
        const summary = await getBatchSummary(pair.agentSCA, pair.merchantSCA, {
          currency: pair.currency,
          tokenAddress: pair.tokenAddress,
        });
        if (!summary.shouldSettle) continue;

        try {
          const res = await settleOnchain(pair.agentSCA, pair.merchantSCA, pairToken, webhookUrl, true);
          results.push({ ...pair, ...res, success: true });
        } catch (err: any) {
          results.push({ ...pair, success: false, error: err.message });
        }
      }

      const settledPairs = results.filter((r) => r.success).length;
      const failedPairs = results.filter((r) => !r.success).length;

      return NextResponse.json({
        success: true,
        settledPairs,
        failedPairs,
        results,
        message: `Auto-settled ${settledPairs} pairs. ${failedPairs} failed.`,
      });
    }

    if (!agentSCA || !merchantSCA) {
      return NextResponse.json(
        { success: false, error: 'agentSCA and merchantSCA are required.' },
        { status: 400 }
      );
    }

    if (!isInternalServiceCall) {
      // ── SECURITY (C1-class): the caller must control the PAYER side of
      // this settlement, not either party. agentSCA is the wallet that gets
      // debited — letting a caller who controls only merchantSCA settle a
      // pair whose payer is the shared platform default wallet drained
      // DEFAULT_PAYER_WALLET_ID to the attacker (assignment-default shape
      // at settleOnchain, now removed). Merchant-side control alone can no
      // longer name a payer it doesn't own.
      const agentOwnsIt = await verifyCallerControlsAddress(request, agentSCA);
      if (!agentOwnsIt) {
        return NextResponse.json(
          { success: false, error: 'You do not control the payer (agentSCA) of this settlement.' },
          { status: 403 }
        );
      }
    }

    // Per-token threshold pre-check. When the caller names a token, only
    // that token's rows count; otherwise each token group is evaluated on
    // its own — one token's dust never blocks (or rides along with) another.
    const summary = await getBatchSummary(
      agentSCA,
      merchantSCA,
      requestedToken ? { currency: requestedToken.symbol, tokenAddress: requestedToken.address } : null
    );

    if (requestedToken) {
      if (summary.total > 0 && !forceSettle && summary.total < NANO_BATCH_THRESHOLD_USDC) {
        return NextResponse.json(
          {
            success: false,
            error: `Threshold not reached. ${summary.total.toFixed(6)}/${NANO_BATCH_THRESHOLD_USDC} ${requestedToken.symbol}.`,
            unsettledBalance: summary.total,
            currency: requestedToken.symbol,
            tokenAddress: requestedToken.address,
          },
          { status: 400 }
        );
      }

      const settlement = await settleOnchain(agentSCA, merchantSCA, requestedToken, webhookUrl, isInternalServiceCall);

      return NextResponse.json({
        success: true,
        ...settlement,
        totalSettled: parseFloat(settlement.total.toFixed(6)),
        paymentsCount: settlement.count,
      });
    }

    // No token named: settle each token group as its own transfer (never
    // merged). A single-token pair keeps the legacy single-settlement shape.
    const groups = summary.tokenGroups;
    if (groups.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No pending payments found or already settling.' },
        { status: 500 }
      );
    }
    const dueGroups = forceSettle ? groups : groups.filter((g) => g.total >= NANO_BATCH_THRESHOLD_USDC);
    if (dueGroups.length === 0) {
      const first = groups[0];
      return NextResponse.json(
        {
          success: false,
          error: `Threshold not reached. ${first.total.toFixed(6)}/${NANO_BATCH_THRESHOLD_USDC} ${first.currency}.`,
          unsettledBalance: first.total,
          currency: first.currency,
          tokenAddress: first.tokenAddress,
        },
        { status: 400 }
      );
    }
    if (dueGroups.length === 1 && groups.length === 1) {
      const token = resolveCurrency({ currency: dueGroups[0].currency, tokenAddress: dueGroups[0].tokenAddress });
      const settlement = await settleOnchain(agentSCA, merchantSCA, token, webhookUrl, isInternalServiceCall);
      return NextResponse.json({
        success: true,
        ...settlement,
        totalSettled: parseFloat(settlement.total.toFixed(6)),
        paymentsCount: settlement.count,
      });
    }

    // Mixed-token pair: one transfer per token, reported separately.
    const settlements = [];
    for (const group of dueGroups) {
      const token = resolveCurrency({ currency: group.currency, tokenAddress: group.tokenAddress });
      try {
        const settlement = await settleOnchain(agentSCA, merchantSCA, token, webhookUrl, isInternalServiceCall);
        settlements.push({
          success: true,
          ...settlement,
          totalSettled: parseFloat(settlement.total.toFixed(6)),
          paymentsCount: settlement.count,
        });
      } catch (err: any) {
        settlements.push({
          success: false,
          currency: token.symbol,
          tokenAddress: token.address,
          error: err.message,
        });
      }
    }
    return NextResponse.json({
      success: true,
      mixedTokens: true,
      settlements,
      message: `Settled ${settlements.filter((s) => s.success).length}/${dueGroups.length} token batches separately — USDC and EURC never share a transfer.`,
    });
  } catch (error: any) {
    console.error('Nano Settlement Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        hint: error.message.includes('balance')
          ? 'Fund the Agent SCA wallet with USDC on Arc Testnet.'
          : undefined,
      },
      { status: 500 }
    );
  }
}

export const POST = withApiKeyOrMerchant(mergedNanoSettleHandler as any);
