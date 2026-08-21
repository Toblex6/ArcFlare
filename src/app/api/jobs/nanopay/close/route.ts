import { NextRequest, NextResponse } from "next/server";
import { createContractTransaction } from "@/lib/circle/client";
import { ARC_FLARE_STREAM_CONTRACT_ADDRESS } from "@/lib/contracts/streamContract";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { recordNanopaymentStreamClosed } from "@/lib/jobs/nanopaymentSplit";

async function closeHandler(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId } = body as { jobId?: string };

    if (!jobId) {
      return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const streamRecord = await prisma.jobNanopaymentStream.findUnique({ where: { jobId: jobId.toString() } });
    if (!streamRecord) {
      return NextResponse.json({ error: "No nanopayment stream found for this job" }, { status: 404 });
    }
    if (streamRecord.closedAt) {
      return NextResponse.json({ error: "Stream is already closed" }, { status: 400 });
    }

    // Authorization: caller controls client (poster) OR evaluator (authorized reviewer)
    const controlsClient = await verifyCallerControlsAddress(req, job.clientSCA);
    const controlsEvaluator = await verifyCallerControlsAddress(req, job.evaluatorSCA);
    if (!controlsClient && !controlsEvaluator) {
      return NextResponse.json({ error: "You do not control this job's client or evaluator wallet." }, { status: 403 });
    }

    // Execute close on-chain (always signed by the poster's wallet)
    const txHash = await createContractTransaction(
      job.clientSCA,
      ARC_FLARE_STREAM_CONTRACT_ADDRESS,
      "closeStream(uint256)",
      [streamRecord.streamId],
      "close nanopayment stream"
    );

    // Record in DB (idempotent)
    const record = await recordNanopaymentStreamClosed({
      jobId: jobId.toString(),
      txHash,
    });

    return NextResponse.json({
      success: true,
      jobId,
      streamId: streamRecord.streamId,
      txHash,
      closedAt: record.closedAt,
      replayed: record.replayed,
    });
  } catch (error: any) {
    console.error("Nanopay close error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(closeHandler);