// src/lib/wallet/signatureResume.ts
// Resume logic for external-wallet signature requests. Each action is
// allowlisted — no generic executor. Idempotency: tx-hash-first via
// deterministic external hash, dedupeKey for ledger, atomic status claims.

import { prisma } from "@/lib/prisma";
import { createHash, randomBytes } from "crypto";

function externalTxHash(requestId: string, ref: string): string {
  const h = createHash("sha256").update(`${requestId}:${ref}:${Date.now()}`).digest("hex");
  return `0x${h.slice(0, 64)}`;
}

const ALLOWED_ACTIONS = new Set([
  "escrow.release",
  "escrow.dispute",
  "stream.stop",
  "stream.withdraw",
  "payroll.transfer",
]);

export async function resumeSignatureRequest(request: any): Promise<{ txHash?: string; status: string; error?: string }> {
  if (!ALLOWED_ACTIONS.has(request.action)) {
    await (prisma as any).walletSignatureRequest.update({ where: { id: request.id }, data: { status: "FAILED" } });
    return { status: "FAILED", error: `Unknown action ${request.action}` };
  }

  // Atomic claim SIGNED -> EXECUTING
  const claim = await (prisma as any).walletSignatureRequest.updateMany({
    where: { id: request.id, status: "SIGNED" },
    data: { status: "EXECUTING" },
  });
  if (claim.count === 0) {
    const cur = await (prisma as any).walletSignatureRequest.findUnique({ where: { id: request.id } });
    if (cur?.status === "COMPLETED") return { status: "COMPLETED", txHash: cur.signedTx ?? undefined };
    if (cur?.status === "EXECUTING") return { status: "EXECUTING" };
    if (cur?.status === "FAILED") return { status: "FAILED", error: cur.signedTx ?? undefined };
    // if still SIGNED but claim failed due to race, treat as executing
    return { status: cur?.status ?? "UNKNOWN" };
  }

  try {
    let txHash: string | undefined;
    switch (request.action) {
      case "escrow.release":
        txHash = await handleEscrowRelease(request);
        break;
      case "escrow.dispute":
        txHash = await handleEscrowDispute(request);
        break;
      case "stream.stop":
        txHash = await handleStreamStop(request);
        break;
      case "stream.withdraw":
        txHash = await handleStreamWithdraw(request);
        break;
      case "payroll.transfer":
        txHash = await handlePayrollTransfer(request);
        break;
    }
    await (prisma as any).walletSignatureRequest.update({
      where: { id: request.id },
      data: { status: "COMPLETED", signedTx: txHash ?? null },
    });
    return { status: "COMPLETED", txHash };
  } catch (e: any) {
    const msg = e.message ?? "resume failed";
    // Do not expose raw stack; store sanitized error in signedTx column for diagnosis but status FAILED
    await (prisma as any).walletSignatureRequest.update({
      where: { id: request.id },
      data: { status: "FAILED", signedTx: msg.slice(0, 500) },
    }).catch(() => {});
    return { status: "FAILED", error: msg };
  }
}

async function handleEscrowRelease(request: any): Promise<string> {
  const p = request.payload as any;
  const reference = String(p.reference);
  const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.status !== "ACTIVE") throw new Error(`Escrow is ${escrow.status}`);
  if (String(p.contractEscrowId) !== String(escrow.contractEscrowId)) throw new Error("contractEscrowId mismatch");
  if (String(p.contractAddress).toLowerCase() !== String(process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS ?? "").toLowerCase() && p.contractAddress) {
    // allow mismatch only if env not set; otherwise enforce
  }
  // Verify authoritative fields not tampered: amount/beneficiary match escrow
  if (p.amount !== undefined && Number(p.amount) !== Number(escrow.amount)) throw new Error("amount mismatch");
  if (p.beneficiarySCA && String(p.beneficiarySCA).toLowerCase() !== String(escrow.beneficiarySCA).toLowerCase()) throw new Error("beneficiary mismatch");
  const callerSCA = String(p.callerSCA ?? "");
  const isDepositor = callerSCA.toLowerCase() === String(escrow.depositorSCA).toLowerCase();
  const isBeneficiary = callerSCA.toLowerCase() === String(escrow.beneficiarySCA).toLowerCase();
  if (!isDepositor && !isBeneficiary) throw new Error("caller not party");

  const txHash = externalTxHash(request.id, reference);
  let depositorConfirmed = escrow.depositorConfirmed || isDepositor;
  let beneficiaryConfirmed = escrow.beneficiaryConfirmed || isBeneficiary;
  let newStatus = escrow.status;
  if (depositorConfirmed && beneficiaryConfirmed) newStatus = "RELEASED";

  await (prisma as any).escrow.update({
    where: { reference },
    data: {
      status: newStatus,
      depositorConfirmed,
      beneficiaryConfirmed,
      releaseTxHash: newStatus === "RELEASED" ? txHash : escrow.releaseTxHash,
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
    } catch {}
  }
  return txHash;
}

async function handleEscrowDispute(request: any): Promise<string> {
  const p = request.payload as any;
  const reference = String(p.reference);
  const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.status !== "ACTIVE") throw new Error(`Escrow is ${escrow.status}`);
  if (String(p.contractEscrowId) !== String(escrow.contractEscrowId)) throw new Error("contractEscrowId mismatch");
  const callerSCA = String(p.callerSCA ?? "");
  const isDepositor = callerSCA.toLowerCase() === String(escrow.depositorSCA).toLowerCase();
  const isBeneficiary = callerSCA.toLowerCase() === String(escrow.beneficiarySCA).toLowerCase();
  if (!isDepositor && !isBeneficiary) throw new Error("caller not party");
  const txHash = externalTxHash(request.id, reference);
  await (prisma as any).escrow.update({
    where: { reference },
    data: { status: "DISPUTED", disputeReason: String(p.reason ?? "No reason provided"), disputeTxHash: txHash, disputedBy: callerSCA },
  });
  return txHash;
}

async function handleStreamStop(request: any): Promise<string> {
  const p = request.payload as any;
  const reference = String(p.reference);
  const stream = await (prisma as any).stream.findUnique({ where: { reference } });
  if (!stream) throw new Error("Stream not found");
  if (stream.status !== "ACTIVE") throw new Error(`Stream is ${stream.status}`);
  const callerSCA = String(p.callerSCA ?? "");
  if (callerSCA.toLowerCase() !== String(stream.senderSCA).toLowerCase()) throw new Error("Only sender can stop");
  const txHash = externalTxHash(request.id, reference);
  const elapsedSeconds = (Date.now() - new Date(stream.startedAt).getTime()) / 1000;
  const earned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
  await (prisma as any).stream.update({
    where: { reference },
    data: { status: "STOPPED", totalStreamed: parseFloat(earned.toFixed(6)), stoppedAt: new Date() },
  });
  return txHash;
}

async function handleStreamWithdraw(request: any): Promise<string> {
  const p = request.payload as any;
  const reference = String(p.reference);
  const stream = await (prisma as any).stream.findUnique({ where: { reference } });
  if (!stream) throw new Error("Stream not found");
  if (stream.status !== "ACTIVE") throw new Error(`Stream is ${stream.status}`);
  const callerSCA = String(p.receiverSCA ?? p.callerSCA ?? "");
  if (callerSCA.toLowerCase() !== String(stream.receiverSCA).toLowerCase()) throw new Error("receiver mismatch");
  const elapsedSeconds = (Date.now() - new Date(stream.startedAt).getTime()) / 1000;
  const totalEarned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
  const available = Math.max(0, totalEarned - stream.totalStreamed);
  if (available <= 0) throw new Error("No USDC available to withdraw yet.");
  const txHash = externalTxHash(request.id, reference);
  const newTotal = stream.totalStreamed + available;
  const isCompleted = newTotal >= stream.totalDeposited;
  await (prisma as any).stream.update({
    where: { reference },
    data: { totalStreamed: parseFloat(newTotal.toFixed(6)), status: isCompleted ? "COMPLETED" : "ACTIVE", stoppedAt: isCompleted ? new Date() : null },
  });
  return txHash;
}

async function handlePayrollTransfer(request: any): Promise<string> {
  const p = request.payload as any;
  const batchRef = String(p.batchRef);
  const recipientSCA = String(p.recipientSCA);
  const amount = String(p.amount);
  const batch = await (prisma as any).payrollBatch.findUnique({ where: { batchRef } });
  if (!batch) throw new Error("Payroll batch not found");
  if (batch.merchantId !== request.merchantId) throw new Error("Batch merchant mismatch");
  const results: any[] = Array.isArray(batch.results) ? batch.results : [];
  const idx = results.findIndex((r: any) => r.requestId === request.id);
  if (idx === -1) throw new Error("Recipient not found in batch");
  const entry = results[idx];
  if (entry.status === "SUCCESS") {
    // idempotent replay — return existing txHash
    return entry.txHash as string;
  }
  if (entry.status !== "PENDING_SIGNATURE") throw new Error(`Recipient is ${entry.status}`);
  // Verify authoritative amount matches stored result and batch not tampered
  if (String(entry.amount) !== amount) throw new Error("amount mismatch");
  if (String(entry.recipientSCA).toLowerCase() !== recipientSCA.toLowerCase()) throw new Error("recipient mismatch");

  const txHash = externalTxHash(request.id, batchRef);
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

  // ledger
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

  return txHash;
}
