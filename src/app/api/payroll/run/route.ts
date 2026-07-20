// src/app/api/payroll/run/route.ts
// Batch payroll — pay N recipients in one call. Wraps the same real
// onchain USDC transfer logic as /api/payments/settle, run in sequence
// across an array of recipients.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrMerchant } from '@/lib/middleware/withMerchantAuth';
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
      throw new Error('Payroll transaction failed onchain.');
    }
  }
  throw new Error('Payroll transaction timed out.');
}

interface PayrollRecipient {
  recipientSCA: string;
  amount: string | number;
  label?: string; // e.g. "Employee ID: EMP-204"
}

async function payOneRecipient(
  payerSCA: string,
  payerWalletId: string,
  recipient: PayrollRecipient,
  circleClient: ReturnType<typeof getCircleClient>
): Promise<string> {
  const amountStr = parseFloat(recipient.amount as any).toFixed(6);

  try {
    const transferTx = await circleClient.createTransaction({
      walletId: payerWalletId,
      blockchain: 'ARC-TESTNET' as any,
      tokenAddress: USDC_ARC,
      destinationAddress: recipient.recipientSCA,
      amounts: [amountStr],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);

    if (!transferTx.data?.id) throw new Error('No transaction ID returned.');
    return await waitForCircleTx(circleClient, transferTx.data.id);
  } catch (err: any) {
    const { parseUnits } = await import('viem');
    const amountWei = parseUnits(amountStr, 6);

    const erc20Tx = await circleClient.createContractExecutionTransaction({
      walletAddress: payerSCA,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [recipient.recipientSCA, amountWei.toString()],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    if (!erc20Tx.data?.id) throw new Error('No transaction ID returned.');
    return await waitForCircleTx(circleClient, erc20Tx.data.id);
  }
}

// ── POST /api/payroll/run ─────────────────────────────────────────────────────
async function runPayrollHandler(request: Request) {
  try {
    const {
      payerSCA,
      payerWalletId,
      recipients, // array of { recipientSCA, amount, label? }
      webhookUrl,
      description,
    } = await request.json();

    if (!payerSCA || !payerWalletId || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'payerSCA, payerWalletId and a non-empty recipients array are required.',
          example: {
            payerSCA: '0xPayerAddress',
            payerWalletId: 'circle-wallet-uuid',
            recipients: [
              { recipientSCA: '0xEmployee1...', amount: '500', label: 'EMP-001' },
              { recipientSCA: '0xEmployee2...', amount: '750', label: 'EMP-002' },
            ],
          },
        },
        { status: 400 }
      );
    }

    const batchRef = `payroll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const totalAmount = recipients.reduce(
      (sum: number, r: PayrollRecipient) => sum + parseFloat(r.amount as any),
      0
    );

    console.log(
      `💰 Running payroll batch: ${recipients.length} recipients, ${totalAmount} USDC total`
    );

    // Create the batch record up front so it's trackable even mid-run
    const batch = await (prisma as any).payrollBatch.create({
      data: {
        batchRef,
        payerSCA,
        payerWalletId,
        totalAmount,
        recipientCount: recipients.length,
        status: 'PROCESSING',
        webhookUrl: webhookUrl || null,
      },
    });

    const circleClient = getCircleClient();
    const results: any[] = [];

    // ── Pay each recipient sequentially ─────────────────────────────────────
    // Sequential (not parallel) to avoid Circle wallet nonce collisions.
    for (const recipient of recipients as PayrollRecipient[]) {
      try {
        const txHash = await payOneRecipient(payerSCA, payerWalletId, recipient, circleClient);
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          label: recipient.label || null,
          status: 'SUCCESS',
          txHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        });
        console.log(`✅ Paid ${recipient.recipientSCA}: ${txHash}`);
      } catch (err: any) {
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          label: recipient.label || null,
          status: 'FAILED',
          error: err.message,
        });
        console.error(`❌ Failed to pay ${recipient.recipientSCA}:`, err.message);
      }
    }

    const successCount = results.filter((r) => r.status === 'SUCCESS').length;
    const failedCount = results.filter((r) => r.status === 'FAILED').length;
    const finalStatus =
      failedCount === 0 ? 'COMPLETED' : successCount === 0 ? 'FAILED' : 'PARTIAL_FAILURE';

    const updatedBatch = await (prisma as any).payrollBatch.update({
      where: { id: batch.id },
      data: {
        successCount,
        failedCount,
        status: finalStatus,
        results: results as any,
        completedAt: new Date(),
      },
    });

    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payroll.completed',
          batchRef,
          status: finalStatus,
          totalAmount,
          successCount,
          failedCount,
          results,
        }),
      }).catch(() => { });
    }

    console.log(
      `✅ Payroll batch ${batchRef} complete: ${successCount}/${recipients.length} succeeded`
    );

    return NextResponse.json({
      success: true,
      batchRef,
      status: finalStatus,
      totalAmount,
      recipientCount: recipients.length,
      successCount,
      failedCount,
      results,
      message: `Payroll batch ${finalStatus} — ${successCount}/${recipients.length} payments succeeded, totalling ${totalAmount} USDC.`,
    });
  } catch (error: any) {
    console.error('❌ Payroll run error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrMerchant(runPayrollHandler);

// ── GET /api/payroll/run?batchRef=xxx — check a batch's status ───────────────
async function getPayrollBatchHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const batchRef = searchParams.get('batchRef');

    if (!batchRef) {
      return NextResponse.json(
        { success: false, error: 'batchRef query param required.' },
        { status: 400 }
      );
    }

    const batch = await (prisma as any).payrollBatch.findUnique({
      where: { batchRef },
    });

    if (!batch) {
      return NextResponse.json(
        { success: false, error: `Payroll batch ${batchRef} not found.` },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, batch });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKeyOrMerchant(getPayrollBatchHandler);