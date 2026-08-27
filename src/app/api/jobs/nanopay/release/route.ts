import { NextRequest, NextResponse } from "next/server";
import { createContractTransaction } from "@/lib/circle/client";
import { ARC_FLARE_STREAM_CONTRACT_ADDRESS } from "@/lib/contracts/streamContract";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { recordNanopaymentTrancheReleased } from "@/lib/jobs/nanopaymentSplit";

async function releaseHandler(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId, requirementIndex } = body as { jobId?: string; requirementIndex?: number };

    if (!jobId) {
      return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
    }
    if (typeof requirementIndex !== "number" || requirementIndex < 0) {
      return NextResponse.json({ error: "requirementIndex must be a non-negative integer" }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const streamRecord = await prisma.jobNanopaymentStream.findUnique({ where: { jobId: jobId.toString() } });
    if (!streamRecord) {
      return NextResponse.json({ error: "No nanopayment stream found for this job" }, { status: 404 });
    }
    if (streamRecord.closedAt) {
      return NextResponse.json({ error: "Stream is closed — cannot release further tranches" }, { status: 400 });
    }
    if (requirementIndex >= streamRecord.trancheCount) {
      return NextResponse.json({ error: `requirementIndex ${requirementIndex} out of range for ${streamRecord.trancheCount} tranches` }, { status: 400 });
    }

    // Authorization: caller controls client (poster) OR evaluator (authorized reviewer)
    const controlsClient = await verifyCallerControlsAddress(req, job.clientSCA);
    const controlsEvaluator = await verifyCallerControlsAddress(req, job.evaluatorSCA);
    if (!controlsClient && !controlsEvaluator) {
      return NextResponse.json({ error: "You do not control this job's client or evaluator wallet." }, { status: 403 });
    }

    // Check idempotency — if already released, return existing txHash
    const existing = await prisma.jobNanopaymentTranche.findUnique({
      where: { jobId_requirementIndex: { jobId: jobId.toString(), requirementIndex } },
    });
    if (existing) {
      return NextResponse.json({
        success: true,
        replayed: true,
        txHash: existing.txHash,
        requirementIndex,
      });
    }

    // Execute release on-chain (always signed by the poster's wallet)
    const txHash = await createContractTransaction(
      job.clientSCA,
      ARC_FLARE_STREAM_CONTRACT_ADDRESS,
      "releaseTranche(uint256,uint256)",
      [streamRecord.streamId, requirementIndex.toString()],
      `release nanopayment tranche ${requirementIndex}`
    );

    // Record in DB (idempotent + recovery handled inside)
    const record = await recordNanopaymentTrancheReleased({
      jobId: jobId.toString(),
      requirementIndex,
      txHash,
    });

    // Build 3 ledger: stream revenue/spend
    try {
      const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
      const { readTrancheAmount } = await import("@/lib/contracts/streamContract");
      const trancheAmt = await readTrancheAmount(BigInt(streamRecord.streamId), requirementIndex).catch(() => 0n);
      const workerAgentId = await resolveAgentIdBySca(streamRecord.workerAddress).catch(() => null);
      const posterAgentId = await resolveAgentIdBySca(job.clientSCA).catch(() => null);
      if (workerAgentId && trancheAmt > 0n) {
        recordLedgerEntry({
          agentRegistryId: workerAgentId,
          type: "STREAM_REVENUE",
          amount: trancheAmt,
          direction: "CREDIT",
          jobId: BigInt(jobId),
          streamId: streamRecord.streamId,
          txHash,
          description: `stream tranche ${requirementIndex} revenue`,
        }).catch(() => {});
      }
      if (posterAgentId && trancheAmt > 0n) {
        recordLedgerEntry({
          agentRegistryId: posterAgentId,
          type: "STREAM_SPEND",
          amount: trancheAmt,
          direction: "DEBIT",
          counterpartyAgentId: workerAgentId ?? null,
          jobId: BigInt(jobId),
          streamId: streamRecord.streamId,
          txHash,
          description: `stream tranche ${requirementIndex} spend`,
        }).catch(() => {});
      }
    } catch {}

    return NextResponse.json({
      success: true,
      jobId,
      requirementIndex,
      txHash,
      replayed: record.replayed,
    });
  } catch (error: any) {
    console.error("Nanopay release error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(releaseHandler);