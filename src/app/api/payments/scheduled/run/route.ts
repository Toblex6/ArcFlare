import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const USDC_ARC = '0x3600000000000000000000000000000000000000';
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';

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
  const walletId = scheduled.payerWalletId || DEFAULT_PAYER_WALLET_ID;
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
async function runScheduledHandler(request: Request) {
  try {
    const now = new Date();

    const dueScheduled = await (prisma as any).scheduledPayment.findMany({
      where: {
        status: 'ACTIVE',
        nextRunAt: { lte: now },
      },
    });

    console.log(`⏰ Found ${dueScheduled.length} due scheduled payment(s)`);

    const circleClient = getCircleClient();
    const results: any[] = [];

    for (const scheduled of dueScheduled) {
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

        console.log(`✅ Executed scheduled payment ${scheduled.reference}: ${txHash}`);
      } catch (err: any) {
        console.error(`❌ Failed scheduled payment ${scheduled.reference}:`, err.message);
        results.push({
          reference: scheduled.reference,
          success: false,
          error: err.message,
        });
      }
    }

    return NextResponse.json({
      success: true,
      checkedAt: now.toISOString(),
      dueCount: dueScheduled.length,
      executedCount: results.filter((r) => r.success).length,
      failedCount: results.filter((r) => !r.success).length,
      results,
    });
  } catch (error: any) {
    console.error('❌ Scheduled run error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(runScheduledHandler);
