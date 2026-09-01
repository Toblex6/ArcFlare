// src/lib/wallet/transactionResume.ts
//
// Executor for external-wallet TRANSACTION requests. Replaces the old
// signatureResume.ts, which manufactured a fake tx hash and marked domain
// state successful from an EIP-191 personal_sign alone.
//
// The ONLY way this module marks anything successful is:
//
//   wallet broadcast (real txHash)
//     -> verifyExternalTransaction() proves the receipt + on-chain effect
//     -> THEN domain state / PaymentLog / ledger are written
//
// A fabricated hash can never reach here: `verifyExternalTransaction` re-reads
// the chain and throws on anything that isn't a real, successful, on-target
// transaction. Idempotency is tx-hash-first: re-submitting a completed
// request replays its recorded txHash and never executes the operation twice.

import { prisma } from "@/lib/prisma";
import {
  VerificationError,
  verifyExternalTransaction,
} from "@/lib/wallet/transactionVerification";
import { TX_ACTIONS } from "@/lib/wallet/signatureQueue";

const SUPPORTED_ACTIONS = new Set<string>(Object.values(TX_ACTIONS));

export type ResumeResult =
  | { status: "COMPLETED"; txHash: string; details?: Record<string, unknown> }
  | { status: "EXECUTING"; txHash?: string }
  | { status: "FAILED"; error: string }
  | { status: "UNKNOWN"; txHash?: string };

async function claimExecuting(requestId: string): Promise<boolean> {
  const claim = await (prisma as any).walletSignatureRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "EXECUTING" },
  });
  return claim.count > 0;
}

/**
 * Verifies a real broadcast txHash against the queued transaction intent and,
 * on success, applies the authoritative domain state + ledger. Idempotent:
 * a COMPLETED request replays its recorded txHash; a FAILED request can be
 * retried with the SAME txHash (the route re-claims it after clearing FAILED).
 */
export async function resumeTransactionRequest(
  request: any,
  txHash: string
): Promise<ResumeResult> {
  if (!SUPPORTED_ACTIONS.has(request.action)) {
    await (prisma as any).walletSignatureRequest.update({
      where: { id: request.id },
      data: { status: "FAILED", signedTx: txHash ?? null },
    });
    return {
      status: "FAILED",
      error: `Unknown transaction action ${request.action} — no executor.`,
    };
  }

  // Idempotent replay: already completed — never re-execute.
  if (request.status === "COMPLETED") {
    return {
      status: "COMPLETED",
      txHash: request.signedTx ?? txHash,
      details: { replayed: true },
    };
  }

  // Atomic claim PENDING -> EXECUTING.
  const claimed = await claimExecuting(request.id);
  if (!claimed) {
    const cur = await (prisma as any).walletSignatureRequest.findUnique({
      where: { id: request.id },
    });
    if (cur?.status === "COMPLETED") {
      return { status: "COMPLETED", txHash: cur.signedTx ?? txHash, details: { replayed: true } };
    }
    if (cur?.status === "EXECUTING") return { status: "EXECUTING" };
    if (cur?.status === "FAILED") {
      return { status: "FAILED", error: cur.signedTx ?? "previous verification failed" };
    }
    return { status: cur?.status ?? "UNKNOWN" };
  }

  try {
    // ── THE authoritative gate ───────────────────────────────────────────
    const verified = await verifyExternalTransaction(request, txHash);

    let details: Record<string, unknown> = {};
    switch (request.action) {
      case TX_ACTIONS.escrowRelease:
        details = await applyEscrowRelease(request, txHash);
        break;
      case TX_ACTIONS.escrowDispute:
        details = await applyEscrowDispute(request, txHash);
        break;
      case TX_ACTIONS.payrollTransfer:
        details = await applyPayrollTransfer(request, txHash);
        break;
    }

    await (prisma as any).walletSignatureRequest.update({
      where: { id: request.id },
      data: { status: "COMPLETED", signedTx: txHash },
    });

    return { status: "COMPLETED", txHash, details };
  } catch (e: any) {
    const msg = e instanceof VerificationError ? e.message : (e.message ?? "verification failed");
    // Store the ATTEMPTED real txHash for diagnosis AND so the merchant can
    // retry the same broadcast after a transient node hiccup. No domain state
    // was changed — verifyExternalTransaction is pure and ran first.
    await (prisma as any).walletSignatureRequest
      .update({
        where: { id: request.id },
        data: { status: "FAILED", signedTx: txHash },
      })
      .catch(() => {});
    return { status: "FAILED", error: msg };
  }
}

// ── escrow.release ───────────────────────────────────────────────────────────

async function applyEscrowRelease(request: any, txHash: string): Promise<Record<string, unknown>> {
  const p = request.payload as any;
  const reference = String(p.reference);
  const callerSCA = String(p.callerSCA ?? "");

  const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
  if (!escrow) throw new VerificationError("Escrow not found.");
  if (escrow.status !== "ACTIVE") {
    // Replay of an already-released escrow — the recorded releaseTxHash must
    // be THIS tx, otherwise refuse (never invent a new success).
    if (escrow.status === "RELEASED" && escrow.releaseTxHash?.toLowerCase() === txHash.toLowerCase()) {
      return { replayed: true, status: "RELEASED" };
    }
    throw new VerificationError(`Escrow is ${escrow.status} — cannot release.`);
  }
  if (String(p.contractEscrowId) !== String(escrow.contractEscrowId)) {
    throw new VerificationError("contractEscrowId mismatch with stored escrow.");
  }

  const isDepositor = callerSCA.toLowerCase() === String(escrow.depositorSCA).toLowerCase();
  const isBeneficiary = callerSCA.toLowerCase() === String(escrow.beneficiarySCA).toLowerCase();
  if (!isDepositor && !isBeneficiary) {
    throw new VerificationError("caller is not a party to this escrow.");
  }

  const depositorConfirmed = escrow.depositorConfirmed || isDepositor;
  const beneficiaryConfirmed = escrow.beneficiaryConfirmed || isBeneficiary;
  const newStatus = depositorConfirmed && beneficiaryConfirmed ? "RELEASED" : "ACTIVE";

  const updated = await (prisma as any).escrow.update({
    where: { reference },
    data: {
      status: newStatus,
      depositorConfirmed,
      beneficiaryConfirmed,
      releaseTxHash: newStatus === "RELEASED" ? txHash : null,
    },
  });

  if (newStatus === "RELEASED") {
    try {
      const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
      const agentId = await resolveAgentIdBySca(escrow.depositorSCA).catch(() => null);
      if (agentId) {
        const amt = BigInt(Math.round(Number(escrow.amount) * 1_000_000));
        await recordLedgerEntry({
          agentRegistryId: agentId,
          type: "JOB_ESCROW_RELEASE",
          amount: amt,
          direction: "CREDIT",
          txHash,
          description: `escrow released ${reference}`,
        });
      }
    } catch (e: any) {
      console.error("[ledger] escrow release failed:", e.message);
    }
    if (escrow.webhookUrl) {
      fetch(escrow.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "escrow.released",
          reference,
          amount: escrow.amount,
          currency: escrow.currency,
          beneficiary: escrow.beneficiarySCA,
          txHash,
          releasedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => {});
    }
  }

  return {
    status: newStatus,
    depositorConfirmed,
    beneficiaryConfirmed,
    released: newStatus === "RELEASED",
    escrow: updated,
  };
}

// ── escrow.dispute ───────────────────────────────────────────────────────────

async function applyEscrowDispute(request: any, txHash: string): Promise<Record<string, unknown>> {
  const p = request.payload as any;
  const reference = String(p.reference);
  const callerSCA = String(p.callerSCA ?? "");

  const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
  if (!escrow) throw new VerificationError("Escrow not found.");
  if (escrow.status !== "ACTIVE") {
    if (escrow.status === "DISPUTED" && escrow.disputeTxHash?.toLowerCase() === txHash.toLowerCase()) {
      return { replayed: true, status: "DISPUTED" };
    }
    throw new VerificationError(`Escrow is ${escrow.status} — cannot dispute.`);
  }
  if (String(p.contractEscrowId) !== String(escrow.contractEscrowId)) {
    throw new VerificationError("contractEscrowId mismatch with stored escrow.");
  }

  const disputeReason = String(p.reason ?? "No reason provided");

  const updated = await (prisma as any).escrow.update({
    where: { reference },
    data: {
      status: "DISPUTED",
      disputeReason,
      disputeTxHash: txHash,
      disputedBy: callerSCA,
    },
  });

  if (escrow.webhookUrl) {
    fetch(escrow.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "escrow.disputed",
        reference,
        amount: escrow.amount,
        currency: escrow.currency,
        disputedBy: callerSCA,
        reason: disputeReason,
        txHash,
        disputedAt: new Date().toISOString(),
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      }),
    }).catch(() => {});
  }

  return { status: "DISPUTED", escrow: updated };
}

// ── payroll.transfer ─────────────────────────────────────────────────────────

async function applyPayrollTransfer(request: any, txHash: string): Promise<Record<string, unknown>> {
  const p = request.payload as any;
  const batchRef = String(p.batchRef);
  const recipientSCA = String(p.recipientSCA).toLowerCase();
  const amount = String(p.amount);

  const batch = await (prisma as any).payrollBatch.findUnique({ where: { batchRef } });
  if (!batch) throw new VerificationError("Payroll batch not found.");
  if (batch.merchantId && batch.merchantId !== request.merchantId) {
    throw new VerificationError("Batch merchant mismatch.");
  }

  const results: any[] = Array.isArray(batch.results) ? batch.results : [];
  const idx = results.findIndex((r: any) => r.requestId === request.id);
  if (idx === -1) throw new VerificationError("Recipient not found in batch.");
  const entry = results[idx];

  // Idempotent replay — the recipient was already proven paid by this tx.
  if (entry.status === "SUCCESS") {
    if (String(entry.txHash).toLowerCase() === txHash.toLowerCase()) {
      return { replayed: true, status: entry.status };
    }
    throw new VerificationError("Recipient is already SUCCESS for a different transaction.");
  }
  if (entry.status !== "PENDING_SIGNATURE") {
    throw new VerificationError(`Recipient is ${entry.status}.`);
  }
  // The broadcast txHash's intent must match the queued recipient/amount
  // (verifyExternalTransaction already enforced the on-chain effect; this is
  // the DB-side binding so a modified row can't redirect the payment).
  if (String(entry.recipientSCA).toLowerCase() !== recipientSCA) {
    throw new VerificationError("recipient mismatch with queued intent.");
  }
  if (String(entry.amount) !== amount) {
    throw new VerificationError("amount mismatch with queued intent.");
  }

  entry.status = "SUCCESS";
  entry.txHash = txHash;
  entry.explorerUrl = `https://testnet.arcscan.app/tx/${txHash}`;

  const successCount = results.filter((r: any) => r.status === "SUCCESS").length;
  const failedCount = results.filter((r: any) => r.status === "FAILED").length;
  const pendingCount = results.filter((r: any) => r.status === "PENDING_SIGNATURE").length;
  let finalStatus: string = batch.status;
  if (pendingCount === 0) {
    finalStatus = failedCount === 0 ? "COMPLETED" : successCount === 0 ? "FAILED" : "PARTIAL_FAILURE";
  } else {
    finalStatus = "AWAITING_SIGNATURES";
  }

  await (prisma as any).payrollBatch.update({
    where: { batchRef },
    data: {
      results: results as any,
      successCount,
      failedCount,
      status: finalStatus,
      completedAt: finalStatus === "AWAITING_SIGNATURES" ? null : new Date(),
    },
  });

  // Ledger — only after a real transfer exists.
  try {
    const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
    const payerAgentId = await resolveAgentIdBySca(batch.payerSCA).catch(() => null);
    if (payerAgentId) {
      const amt = BigInt(Math.round(parseFloat(amount) * 1_000_000));
      const recipientAgentId = await resolveAgentIdBySca(recipientSCA).catch(() => null);
      await recordLedgerEntry({
        agentRegistryId: payerAgentId,
        type: "PAYROLL_SPEND",
        amount: amt,
        direction: "DEBIT",
        counterpartyAgentId: recipientAgentId ?? null,
        txHash,
        description: entry.label ? `payroll: ${entry.label}` : `payroll to ${recipientSCA}`,
      }).catch(() => {});
      if (recipientAgentId) {
        await recordLedgerEntry({
          agentRegistryId: recipientAgentId,
          type: "REVENUE",
          amount: amt,
          direction: "CREDIT",
          counterpartyAgentId: payerAgentId,
          txHash,
          description: `payroll revenue from ${batch.payerSCA}`,
        }).catch(() => {});
      }
    }
  } catch {}

  return {
    status: finalStatus,
    successCount,
    failedCount,
    pendingCount,
    batchRef,
    entry,
  };
}
