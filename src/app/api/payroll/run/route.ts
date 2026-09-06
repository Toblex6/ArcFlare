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
import { queueTransactionRequest, TX_ACTIONS } from '@/lib/wallet/signatureQueue';
import { ARC_TESTNET_CHAIN_ID } from '@/lib/wallet/flarehqContracts';
import { resolveCurrency } from '@/lib/tokens/resolveCurrency';
import { parseUnits } from 'viem';

interface PayrollRecipient {
  recipientSCA: string;
  amount: string | number;
  label?: string; // e.g. "Employee ID: EMP-204"
}

// H8 hardening: every recipient amount must be a positive decimal with at
// most 6 decimals — NaN/negative/malformed/"1e3"/excess-precision inputs
// are rejected instead of being silently toFixed(6)-coerced.
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_RECIPIENTS_PER_BATCH = 200;

/** Returns a normalized amount string, or null when invalid. */
function normalizeAmount(raw: unknown): string | null {
  const str = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  if (!AMOUNT_RE.test(str)) return null;
  const n = parseFloat(str);
  if (!Number.isFinite(n) || n <= 0) return null;
  return str;
}

// ── POST /api/payroll/run ─────────────────────────────────────────────────────
async function runPayrollHandler(request: NextRequest) {
  try {
    const merchant = await resolveMerchant(request);
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

    // Phase 2C: a payroll batch is always single-token. The batch-level
    // currency/tokenAddress resolves through the canonical resolver
    // (rejects unsupported symbols/addresses and mismatches); legacy
    // callers omit both and pay USDC exactly as before. Every leg below —
    // storage, transfer, fee accounting, messaging, settlement, ledger,
    // batch state — carries this token. USDC and EURC recipients are never
    // mixed inside one batch.
    const { recipients, webhookUrl, description, idempotencyKey, currency, tokenAddress } = await request.json();

    let token;
    try {
      token = resolveCurrency({ currency, tokenAddress });
    } catch (tokenError: any) {
      return NextResponse.json(
        { success: false, error: tokenError.message },
        { status: 400 }
      );
    }

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

    if (recipients.length > MAX_RECIPIENTS_PER_BATCH) {
      return NextResponse.json(
        { success: false, error: `Too many recipients — max ${MAX_RECIPIENTS_PER_BATCH} per batch.` },
        { status: 400 }
      );
    }

    // ── H8: strict per-recipient validation ──
    const normalized: PayrollRecipient[] = [];
    for (const recipient of recipients) {
      if (!recipient || typeof recipient !== 'object') {
        return NextResponse.json({ success: false, error: 'Each recipient must be an object.' }, { status: 400 });
      }
      const sca = typeof recipient.recipientSCA === 'string' ? recipient.recipientSCA.trim() : '';
      if (!ADDRESS_RE.test(sca)) {
        return NextResponse.json(
          { success: false, error: `recipientSCA "${recipient.recipientSCA}" is not a valid address.` },
          { status: 400 }
        );
      }
      const amount = normalizeAmount(recipient.amount);
      if (amount === null) {
        return NextResponse.json(
          { success: false, error: `recipient ${sca}: amount "${recipient.amount}" is invalid — use a positive number with up to 6 decimals.` },
          { status: 400 }
        );
      }
      normalized.push({ recipientSCA: sca, amount, label: typeof recipient.label === 'string' ? recipient.label : undefined });
    }
    recipients.length = 0;
    recipients.push(...normalized);

    // ── H8: idempotency — a retried POST with the same idempotencyKey must
    // replay the ORIGINAL batch, never pay the recipients again. The batch
    // record is created only if the deterministic batchRef is unused; a
    // unique-violation race (concurrent duplicate) also replays.
    const idemRef = idempotencyKey ? `payroll_idem_${String(idempotencyKey).slice(0, 120)}` : null;
    if (idemRef) {
      const existing = await (prisma as any).payrollBatch.findUnique({ where: { batchRef: idemRef } });
      if (existing) {
        // Wrong-token rejection on replay: a retried POST naming a DIFFERENT
        // token than the original batch replays nothing — it is refused
        // instead of paying (or appearing to pay) in the wrong asset.
        if (currency != null || tokenAddress != null) {
          const existingToken = (() => {
            try {
              return resolveCurrency({ currency: existing.currency, tokenAddress: existing.tokenAddress });
            } catch {
              return null;
            }
          })();
          if (!existingToken || existingToken.address.toLowerCase() !== token.address.toLowerCase()) {
            return NextResponse.json(
              {
                success: false,
                error: `idempotencyKey replay token mismatch: original batch ${idemRef} is ${existingToken?.symbol ?? existing?.currency ?? 'unknown'} but this request names ${token.symbol} — refusing to replay across tokens.`,
              },
              { status: 400 }
            );
          }
        }
        return NextResponse.json({
          success: true,
          replayed: true,
          batchRef: existing.batchRef,
          status: existing.status,
          totalAmount: existing.totalAmount,
          currency: existing.currency,
          tokenAddress: existing.tokenAddress,
          recipientCount: existing.recipientCount,
          successCount: existing.successCount,
          failedCount: existing.failedCount,
          results: existing.results ?? [],
        });
      }
    }

    const walletProvider = await resolveWalletProvider(merchant.id);
    const payerSCA = await walletProvider.getAddress();

    const batchRef = idemRef ?? `payroll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const totalAmount = recipients.reduce(
      (sum: number, r: PayrollRecipient) => sum + parseFloat(r.amount as any),
      0
    );

    console.log(
      `💰 Running payroll batch: ${recipients.length} recipients, ${totalAmount} ${token.symbol} total, payer wallet kind: ${walletProvider.kind}`
    );

    // Create the batch record up front so it's trackable even mid-run
    let batch: any;
    try {
      batch = await (prisma as any).payrollBatch.create({
        data: {
          batchRef,
          payerSCA,
          payerWalletId: walletProvider.kind, // was a Circle walletId; now the wallet kind, Circle wallet lookup happens inside the provider
          totalAmount,
          currency: token.symbol,
          tokenAddress: token.address,
          recipientCount: recipients.length,
          status: 'PROCESSING',
          webhookUrl: webhookUrl || null,
          merchantId: merchant.id,
        },
      });
    } catch (createError: any) {
      // Unique batchRef violation = a concurrent identical request won the
      // race — replay its batch instead of double-paying.
      if (idemRef && createError?.code === 'P2002') {
        const winner = await (prisma as any).payrollBatch.findUnique({ where: { batchRef: idemRef } });
        if (winner) {
          return NextResponse.json({
            success: true,
            replayed: true,
            batchRef: winner.batchRef,
            status: winner.status,
            totalAmount: winner.totalAmount,
            currency: winner.currency,
            tokenAddress: winner.tokenAddress,
            recipientCount: winner.recipientCount,
            successCount: winner.successCount,
            failedCount: winner.failedCount,
            results: winner.results ?? [],
          });
        }
      }
      throw createError;
    }

    const results: any[] = [];
    let pendingSignatureCount = 0;
    const isExternal = walletProvider.kind !== "CIRCLE";

    // ── Pay each recipient sequentially ─────────────────────────────────────
    // Sequential (not parallel) to avoid wallet nonce collisions, same as before.
    for (const recipient of recipients as PayrollRecipient[]) {
      const amountStr = String(recipient.amount);
      if (isExternal) {
        // External wallet: each recipient is a REAL token.transfer the wallet
        // broadcasts — against the batch's canonical token contract, never a
        // hardcoded USDC address. The batch stays AWAITING_SIGNATURES until
        // each transfer is proven on-chain; nothing is marked SUCCESS before
        // a receipt.
        const amountWei = parseUnits(amountStr, token.decimals).toString();
        const req = await queueTransactionRequest({
          merchantId: merchant.id,
          action: TX_ACTIONS.payrollTransfer,
          actionRefId: `${batchRef}:${recipient.recipientSCA}`,
          payload: {
            kind: "transaction",
            batchRef,
            recipientSCA: recipient.recipientSCA,
            amount: amountStr,
            currency: token.symbol,
            tokenAddress: token.address,
            label: recipient.label || null,
            payerSCA,
            transaction: {
              description: `Payroll payment of ${amountStr} ${token.symbol} to ${recipient.recipientSCA}`,
              chainId: ARC_TESTNET_CHAIN_ID,
              to: token.address,
              from: payerSCA,
              abiFunctionSignature: 'transfer(address,uint256)',
              args: [recipient.recipientSCA, amountWei],
              value: '0',
            },
          },
        });
        pendingSignatureCount++;
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          currency: token.symbol,
          tokenAddress: token.address,
          label: recipient.label || null,
          status: 'PENDING_SIGNATURE',
          requestId: req.id,
        });
        console.log(`⏳ Queued payroll transfer for ${recipient.recipientSCA}: ${req.id}`);
        continue;
      }
      // Phase 2C: the batch's canonical token moves — USDC batches behave
      // exactly as before (transferUSDC ≡ transferToken(USDC)).
      const outcome = await walletProvider.transferToken(
        recipient.recipientSCA,
        amountStr,
        token.address,
        token.decimals,
        recipient.label || description || 'Payroll payment'
      );

      if (outcome.status === 'completed') {
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          currency: token.symbol,
          tokenAddress: token.address,
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
          currency: token.symbol,
          tokenAddress: token.address,
          label: recipient.label || null,
          status: 'PENDING_SIGNATURE',
          requestId: outcome.requestId,
        });
        console.log(`⏳ Queued signature request for ${recipient.recipientSCA}: ${outcome.requestId}`);
      } else {
        results.push({
          recipientSCA: recipient.recipientSCA,
          amount: recipient.amount,
          currency: token.symbol,
          tokenAddress: token.address,
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

    // Build 5 ledger: PAYROLL_SPEND for each successful recipient (awaited, idempotent)
    // Only if payer maps to an AgentRegistry (agent treasury payroll). Merchant payroll without agent mapping is not ledger-tracked.
    // Phase 2C: entries carry the batch's canonical token symbol + address —
    // a USDC spend is never recorded as EURC (or vice versa). For USDC
    // batches this is identical to the USDC-only identity.
    try {
      const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
      const payerAgentId = await resolveAgentIdBySca(payerSCA).catch(() => null);
      if (payerAgentId) {
        for (const r of results) {
          if (r.status !== "SUCCESS" || !r.txHash) continue;
          const amt = BigInt(Math.round(parseFloat(String(r.amount)) * 10 ** token.decimals));
          const recipientAgentId = await resolveAgentIdBySca(r.recipientSCA).catch(() => null);
          try {
            await recordLedgerEntry({
              agentRegistryId: payerAgentId,
              type: "PAYROLL_SPEND",
              amount: amt,
              token: token.symbol,
              tokenAddress: token.address,
              direction: "DEBIT",
              counterpartyAgentId: recipientAgentId ?? null,
              txHash: r.txHash,
              description: r.label ? `payroll: ${r.label}` : `payroll to ${r.recipientSCA}`,
            });
          } catch (e: any) { console.error("[ledger] payroll spend failed:", e.message); }
          if (recipientAgentId) {
            try {
              await recordLedgerEntry({
                agentRegistryId: recipientAgentId,
                type: "REVENUE",
                amount: amt,
                token: token.symbol,
                tokenAddress: token.address,
                direction: "CREDIT",
                counterpartyAgentId: payerAgentId,
                txHash: r.txHash,
                description: `payroll revenue from ${payerSCA}`,
              });
            } catch {}
          }
        }
      }
    } catch (e: any) { console.error("[ledger] payroll instrumentation error:", e.message); }

    if (webhookUrl && finalStatus !== 'AWAITING_SIGNATURES') {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payroll.completed',
          batchRef,
          status: finalStatus,
          totalAmount,
          currency: token.symbol,
          tokenAddress: token.address,
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
      currency: token.symbol,
      tokenAddress: token.address,
      recipientCount: recipients.length,
      successCount,
      failedCount,
      pendingSignatureCount,
      results,
      message:
        finalStatus === 'AWAITING_SIGNATURES'
          ? `${pendingSignatureCount} payment(s) need your wallet's approval before this batch completes — check /api/merchant/wallet/sign-requests.`
          : `Payroll batch ${finalStatus} — ${successCount}/${recipients.length} payments succeeded, totalling ${totalAmount} ${token.symbol}.`,
    });
  } catch (error: any) {
    console.error('❌ Payroll run error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = runPayrollHandler;

// ── GET /api/payroll/run?batchRef=xxx — check a batch's status ───────────────
// ── GET /api/payroll/run?list=1     — list the merchant's recent batches ─────
async function getPayrollBatchHandler(request: NextRequest) {
  try {
    const merchant = await resolveMerchant(request);
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const batchRef = searchParams.get('batchRef');

    // List mode: no batchRef → the merchant's most recent batches (newest
    // first). Previously GET hard-required batchRef, so there was no way to
    // discover a batch's reference after closing the run response — lookup
    // was write-down-the-ref-or-lose-it.
    if (!batchRef) {
      const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10) || 10, 50);
      const batches = await (prisma as any).payrollBatch.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          batchRef: true,
          status: true,
          totalAmount: true,
          currency: true,
          tokenAddress: true,
          recipientCount: true,
          successCount: true,
          failedCount: true,
          createdAt: true,
        },
      });
      return NextResponse.json({ success: true, count: batches.length, batches });
    }

    // H8: tenant-scoped — a merchant may only read its OWN batches (the
    // merchantId is stamped at creation). Cross-tenant lookups 404.
    const batch = await (prisma as any).payrollBatch.findFirst({
      where: { batchRef, merchantId: merchant.id },
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