// src/app/api/payments/nano/settle/route_C.ts
// 📦 MERGED NANO SETTLEMENT ROUTE
// Combines On-chain USDC movement with robust validation and rate limiting.

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
  NANO_BATCH_THRESHOLD_USDC,
} from '@/src/lib/nanopayment';

// ── Constants & Types ────────────────────────────────────────────────────────
const USDC_ARC = '0x3600000000000000000000000000000000000000';
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

// ── Core On-chain Logic ──────────────────────────────────────────────────────

async function recoverStaleLocks(agentSCA: string, merchantSCA: string) {
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
    await prisma.$transaction(async (tx) => {
      await tx.nanoPayment.updateMany({
        where: { batchRef: stale.reference, agentSCA, merchantSCA, settled: false },
        data: { batchRef: null },
      });
      await tx.paymentLog.update({
        where: { id: stale.id },
        data: { status: 'EXPIRED' },
      });
    });
  }
}

async function resumeExistingTransaction(agentSCA: string, merchantSCA: string) {
  const existingLog = await prisma.paymentLog.findFirst({
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

  if (existingLog?.circleTxId) {
    const circleClient = getCircleClient();
    try {
      const txHash = await waitForCircleTx(circleClient, existingLog.circleTxId);

      await prisma.$transaction(async (tx) => {
        await tx.nanoPayment.updateMany({
          where: {
            batchRef: existingLog.reference,
            agentSCA,
            merchantSCA,
            settled: false,
          },
          data: { settled: true },
        });

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
      };
    } catch (error: any) {
      if (error.name === 'CircleTxFailedError') {
        await prisma.$transaction(async (tx) => {
          await tx.nanoPayment.updateMany({
            where: { batchRef: existingLog.reference, agentSCA, merchantSCA, settled: false },
            data: { batchRef: null },
          });
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
  webhookUrl?: string,
  isInternalServiceCall = false
) {
  await recoverStaleLocks(agentSCA, merchantSCA);

  const resumedTx = await resumeExistingTransaction(agentSCA, merchantSCA);
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

  const { total, count } = await prisma.$transaction(async (tx) => {
    await tx.nanoPayment.updateMany({
      where: { agentSCA, merchantSCA, settled: false, batchRef: null },
      data: { batchRef },
    });

    const lockedRows = await tx.nanoPayment.findMany({
      where: { batchRef, agentSCA, merchantSCA, settled: false },
    });

    const lockedTotal = lockedRows.reduce((sum, n) => sum + n.amount, 0);

    if (lockedRows.length > 0) {
      await tx.paymentLog.create({
        data: {
          reference: batchRef,
          amount: lockedTotal,
          currency: 'USDC',
          chain: 'ARC-TESTNET',
          senderEmail: 'nano-batch-system',
          merchant: merchantSCA,
          agentSCA: agentSCA,
          status: 'PENDING',
        },
      });
    }

    return { total: lockedTotal, count: lockedRows.length };
  });

  if (count === 0 || total <= 0) {
    throw new Error('No pending payments found or already settling.');
  }

  const amountStr = total.toFixed(6);
  const amountScaled = Math.floor(total * 1e6).toString();
  let transferTx;

  try {
    transferTx = await circleClient.createTransaction({
      walletId: payerWalletId,
      blockchain: 'ARC-TESTNET',
      tokenAddress: USDC_ARC,
      destinationAddress: merchantSCA,
      amounts: [amountStr],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);
  } catch (nativeError: any) {
    transferTx = await circleClient.createContractExecutionTransaction({
      walletId: payerWalletId,
      blockchain: 'ARC-TESTNET',
      contractAddress: USDC_ARC,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [merchantSCA, amountScaled],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);
  }

  if (!transferTx?.data?.id) {
    await prisma.$transaction(async (tx) => {
      await tx.nanoPayment.updateMany({
        where: { batchRef, agentSCA, merchantSCA, settled: false },
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
        where: { batchRef, agentSCA, merchantSCA, settled: false },
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
        totalSettled: total,
        paymentsCount: count,
        txHash,
        explorerUrl,
        settledAt: new Date().toISOString(),
      });
    }

    return { batchRef, txHash, explorerUrl, total, count, resumed: false };
  } catch (error: any) {
    if (error.name === 'CircleTxFailedError') {
      await prisma.$transaction(async (tx) => {
        await tx.nanoPayment.updateMany({
          where: { batchRef, agentSCA, merchantSCA, settled: false },
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

    const body = await request.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(NanoSettleSchema, body);
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
      const pairs = await getUnsettledPairs();
      const results = [];

      for (const pair of pairs) {
        const summary = await getBatchSummary(pair.agentSCA, pair.merchantSCA);
        if (!summary.shouldSettle) continue;

        try {
          const res = await settleOnchain(pair.agentSCA, pair.merchantSCA, webhookUrl, true);
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

    const preCheck = await prisma.nanoPayment.aggregate({
      _sum: { amount: true },
      where: { agentSCA, merchantSCA, settled: false, batchRef: null },
    });

    const looseTotal = preCheck._sum.amount || 0;

    if (looseTotal > 0 && !forceSettle && looseTotal < NANO_BATCH_THRESHOLD_USDC) {
      return NextResponse.json(
        {
          success: false,
          error: `Threshold not reached. ${looseTotal.toFixed(6)}/${NANO_BATCH_THRESHOLD_USDC} USDC.`,
          unsettledBalance: looseTotal,
        },
        { status: 400 }
      );
    }

    const settlement = await settleOnchain(agentSCA, merchantSCA, webhookUrl, isInternalServiceCall);

    return NextResponse.json({
      success: true,
      ...settlement,
      totalSettled: parseFloat(settlement.total.toFixed(6)),
      paymentsCount: settlement.count,
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
