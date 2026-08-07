// src/app/api/payroll/run/route.ts
// Batch payroll — pay N recipients in one call.
//
// SECURITY FIX: previously trusted payerSCA/payerWalletId directly from the
// request body — any caller with a valid API key could name ANY wallet as
// the payer, not just their own. Now resolves the payer from the
// authenticated merchant via resolveMerchant(req) — payroll is a genuine
// single-owner case (a merchant paying its own employees from its own
// wallet), so there's no ambiguity to preserve here, unlike Escrow/Stream.
//
// WALLET ABSTRACTION: now executes through resolveWalletProvider() instead
// of calling Circle directly. For Circle wallets this is a straight
// behavior-preserving swap. For external wallets, each recipient payment
// needs its own signature (there's no batch-signing across N unrelated
// transfers on a standard EOA) — so a payroll batch on an external wallet
// produces up to N separate pending_signature requests, not one. The batch
// record reflects that with an AWAITING_SIGNATURES status. Auto-resuming a
// batch as individual signatures land is NOT built yet (same boundary noted
// in the sign-requests endpoints) — for now, an external-wallet merchant
// finishes a payroll run by signing each queued request and the batch
// status has to be re-checked afterward, not this call it will.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { resolveWalletProvider } from '@/lib/wallet/resolve';

interface PayrollRecipient {
  recipientSCA: string;
  amount: string | number;
  label?: string; // e.g. "Employee ID: EMP-204"
}

// ── POST /api/payroll/run ─────────────────────────────────────────────────────
async function runPayrollHandler(request: NextRequest) {
  try {
    const merchant = await resolveMerchant(request);
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

    const { recipients, webhookUrl, description } = await request.json();

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'A non-empty recipients array is required.',
          example: {
            recipients: [
              { recipientSCA: '0xEmployee1...', amount: '500', label: 'EMP-001' },
              { recipientSCA: '0xEmployee2...', amount: '750', label: 'EMP-002' },
            ],
          },
        },
        { status: 400 }
      );
    }

    const walletProvider = await resolveWalletProvider(merchant.id);
    const payerSCA = await walletProvider.getAddress();

    const batchRef = `payroll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const totalAmount = recipients.reduce(
      (sum: number, r: PayrollRecipient) => sum + parseFloat(r.amount as any),
      0
    );

    console.log(
      `💰 Running payroll batch: ${recipients.length} recipients, ${totalAmount} USDC total, payer wallet kind: ${walletProvider.kind}`
    );

    // Create the batch record up front so it's trackable even mid-run
    const batch = await (prisma as any).payrollBatch.create({
      data: {
        batchRef,
        payerSCA,
        payerWalletId: walletProvider.kind, // was a Circle walletId; now the wallet kind, Circle wallet lookup happens inside the provider
        totalAmount,
        recipientCount: recipients.length,
        status: 'PROCESSING',
        webhookUrl: webhookUrl || null,
      },
    });

    const results: any[] = [];
    let pendingSignatureCount = 0;

    // ── Pay each recipient sequentially ─────────────────────────────────────
    // Sequential (not parallel) to avoid wallet nonce collisions, same as before.
    for (const recipient of recipients as PayrollRecipient[]) {
      const amountStr = parseFloat(recipient.amount as any).toFixed(6);
      const outcome = await walletProvider.transferUSDC(
        recipient.recipientSCA,
        amountStr,
        recipient.label || description || 'Payroll payment'
      );

      if (outcome.status === 'completed') {
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          label: recipient.label || null,
          status: 'SUCCESS',
          txHash: outcome.txHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${outcome.txHash}`,
        });
        console.log(`✅ Paid ${recipient.recipientSCA}: ${outcome.txHash}`);
      } else if (outcome.status === 'pending_signature') {
        pendingSignatureCount++;
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          label: recipient.label || null,
          status: 'PENDING_SIGNATURE',
          requestId: outcome.requestId,
        });
        console.log(`⏳ Queued signature request for ${recipient.recipientSCA}: ${outcome.requestId}`);
      } else {
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          label: recipient.label || null,
          status: 'FAILED',
          error: outcome.error,
        });
        console.error(`❌ Failed to pay ${recipient.recipientSCA}:`, outcome.error);
      }
    }

    const successCount = results.filter((r) => r.status === 'SUCCESS').length;
    const failedCount = results.filter((r) => r.status === 'FAILED').length;
    const finalStatus =
      pendingSignatureCount > 0
        ? 'AWAITING_SIGNATURES'
        : failedCount === 0
          ? 'COMPLETED'
          : successCount === 0
            ? 'FAILED'
            : 'PARTIAL_FAILURE';

    const updatedBatch = await (prisma as any).payrollBatch.update({
      where: { id: batch.id },
      data: {
        successCount,
        failedCount,
        status: finalStatus,
        results: results as any,
        completedAt: finalStatus === 'AWAITING_SIGNATURES' ? null : new Date(),
      },
    });

    if (webhookUrl && finalStatus !== 'AWAITING_SIGNATURES') {
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
      `✅ Payroll batch ${batchRef}: ${successCount} succeeded, ${pendingSignatureCount} awaiting signature, ${failedCount} failed`
    );

    return NextResponse.json({
      success: true,
      batchRef,
      status: finalStatus,
      totalAmount,
      recipientCount: recipients.length,
      successCount,
      failedCount,
      pendingSignatureCount,
      results,
      message:
        finalStatus === 'AWAITING_SIGNATURES'
          ? `${pendingSignatureCount} payment(s) need your wallet's approval before this batch completes — check /api/merchant/wallet/sign-requests.`
          : `Payroll batch ${finalStatus} — ${successCount}/${recipients.length} payments succeeded, totalling ${totalAmount} USDC.`,
    });
  } catch (error: any) {
    console.error('❌ Payroll run error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = runPayrollHandler;

// ── GET /api/payroll/run?batchRef=xxx — check a batch's status ───────────────
async function getPayrollBatchHandler(request: NextRequest) {
  try {
    const merchant = await resolveMerchant(request);
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

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

export const GET = getPayrollBatchHandler;