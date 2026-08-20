import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const USDC_ARC = '0x3600000000000000000000000000000000000000';

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string
): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === 'FAILED') {
      throw new Error('Scheduled payment transaction failed onchain.');
    }
  }
  throw new Error('Scheduled payment transaction timed out.');
}

async function executeOnePayment(scheduled: any, circleClient: ReturnType<typeof getCircleClient>) {
  // FAIL CLOSED — no shared-default fallback, ever. A schedule with no
  // explicitly resolved payer wallet must not execute: the C1-class drain
  // used `payerWalletId || DEFAULT_PAYER_WALLET_ID` to debit the shared
  // platform wallet for arbitrary payers. Creation resolves the wallet
  // (ConsumerAccount / AgentRegistry / platform agent) and refuses to
  // persist a row it cannot bind — a null payerWalletId here means a row
  // from before that rule, or a payer with no Circle-custodied wallet;
  // either way it stays unpaid until the payer is bound.
  if (!scheduled.payerWalletId) {
    throw new Error(
      `Scheduled payment ${scheduled.reference} has no resolved payer wallet (payerWalletId is null) — refusing to execute against a shared default.`
    );
  }
  const walletId = scheduled.payerWalletId;
  const amountStr = scheduled.amount.toFixed(6);

  let txHash: string;

  try {
    const transferTx = await circleClient.createTransaction({
      walletId,
      blockchain: 'ARC-TESTNET' as any,
      tokenAddress: USDC_ARC,
      destinationAddress: scheduled.receiverSCA,
      amounts: [amountStr],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);

    if (!transferTx.data?.id) throw new Error('No transaction ID returned.');
    txHash = await waitForCircleTx(circleClient, transferTx.data.id);
  } catch (err: any) {
    const { parseUnits } = await import('viem');
    const amountWei = parseUnits(amountStr, 6);

    const erc20Tx = await circleClient.createContractExecutionTransaction({
      walletAddress: scheduled.payerSCA,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [scheduled.receiverSCA, amountWei.toString()],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    if (!erc20Tx.data?.id) throw new Error('No transaction ID returned.');
    txHash = await waitForCircleTx(circleClient, erc20Tx.data.id);
  }

  return txHash;
}

// ── POST /api/payments/scheduled/run ──────────────────────────────────────────
//
// DOUBLE-PAYMENT PROTECTION (H7): two concurrent /run calls (or a retry
// while one is still executing) must never both pay the same scheduled row.
// Each due row is claimed ATOMICALLY (status ACTIVE → PROCESSING via a
// conditional updateMany keyed on id + status) before it is executed. Only
// the runner whose claim succeeded processes the row; a concurrent runner
// sees 0 claimed rows and skips them. A row left PROCESSING by a crashed
// runner is reclaimed after STALE_CLAIM_MS (lastRunAt is stamped at claim
// time, so a crashed run can't block the row forever).
const STALE_CLAIM_MS = 5 * 60 * 1000;

async function runScheduledHandler(request: Request) {
  try {
    const now = new Date();

    const candidates = await (prisma as any).scheduledPayment.findMany({
      where: {
        nextRunAt: { lte: now },
        OR: [
          { status: 'ACTIVE' },
          // Stale PROCESSING rows (left behind by a crashed runner) are
          // reclaimable; fresh PROCESSING rows belong to a live runner.
          { status: 'PROCESSING', lastRunAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) } },
        ],
      },
    });

    console.log(`⏰ Found ${candidates.length} due scheduled payment(s)`);

    if (candidates.length === 0) {
      return NextResponse.json({
        success: true,
        checkedAt: now.toISOString(),
        dueCount: 0,
        executedCount: 0,
        failedCount: 0,
        results: [],
      });
    }

    const circleClient = getCircleClient();
    const results: any[] = [];
    let executedCount = 0;
    let failedCount = 0;

    for (const scheduled of candidates) {
      // Per-row ATOMIC claim. Exactly one runner can flip this row into
      // PROCESSING; a concurrent runner's updateMany matches 0 rows and
      // skips it — no double payment. Stale PROCESSING rows are only
      // reclaimable if their claim stamp is old enough (crash recovery).
      const claim = await (prisma as any).scheduledPayment.updateMany({
        where: {
          id: scheduled.id,
          status: scheduled.status,
          ...(scheduled.status === 'PROCESSING' ? { lastRunAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) } } : {}),
        },
        data: { status: 'PROCESSING', lastRunAt: now },
      });

      if (claim.count === 0) {
        results.push({
          reference: scheduled.reference,
          success: false,
          error: 'skipped — already claimed by another runner',
        });
        continue;
      }

      try {
        const txHash = await executeOnePayment(scheduled, circleClient);

        const newRunCount = scheduled.runCount + 1;
        const isComplete = scheduled.maxRuns && newRunCount >= scheduled.maxRuns;

        await (prisma as any).scheduledPayment.update({
          where: { id: scheduled.id },
          data: {
            lastRunAt: now,
            runCount: newRunCount,
            nextRunAt: new Date(now.getTime() + scheduled.intervalDays * 24 * 60 * 60 * 1000),
            status: isComplete ? 'COMPLETED' : 'ACTIVE',
          },
        });

        if (scheduled.webhookUrl) {
          fetch(scheduled.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'scheduled_payment.executed',
              reference: scheduled.reference,
              amount: scheduled.amount,
              txHash,
              explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
              runCount: newRunCount,
              nextRunAt: isComplete
                ? null
                : new Date(now.getTime() + scheduled.intervalDays * 24 * 60 * 60 * 1000),
            }),
          }).catch(() => {});
        }

        results.push({
          reference: scheduled.reference,
          success: true,
          txHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        });
        executedCount++;
        console.log(`✅ Executed scheduled payment ${scheduled.reference}: ${txHash}`);
      } catch (err: any) {
        // Release the claim back to ACTIVE so the failure is retried on the
        // next tick (prior behavior for failures), never double-success.
        await (prisma as any).scheduledPayment
          .updateMany({
            where: { id: scheduled.id, status: 'PROCESSING' },
            data: { status: 'ACTIVE' },
          })
          .catch(() => {});
        console.error(`❌ Failed scheduled payment ${scheduled.reference}:`, err.message);
        results.push({
          reference: scheduled.reference,
          success: false,
          error: err.message,
        });
        failedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      checkedAt: now.toISOString(),
      dueCount: candidates.length,
      executedCount,
      failedCount,
      results,
    });
  } catch (error: any) {
    console.error('❌ Scheduled run error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(runScheduledHandler);
