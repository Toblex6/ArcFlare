import { NextRequest, NextResponse } from "next/server";
import { createContractTransaction } from "@/lib/circle/client";
import { USDC_CONTRACT } from "@/lib/contracts/erc8183";
import { ARC_FLARE_STREAM_CONTRACT_ADDRESS, ARC_FLARE_STREAM_ABI, computeTrancheAmounts } from "@/lib/contracts/streamContract";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { Interface } from "ethers";
import { recordNanopaymentStreamOpened } from "@/lib/jobs/nanopaymentSplit";
import type { AcceptanceCriteria } from "@/lib/jobs/criteriaHash";

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const streamIface = new Interface(ARC_FLARE_STREAM_ABI as unknown as string[]);

async function openHandler(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId, criteria } = body as { jobId?: string; criteria?: AcceptanceCriteria };

    if (!jobId) {
      return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
    }
    if (!criteria || !Array.isArray(criteria.requirements) || criteria.requirements.length === 0) {
      return NextResponse.json({ error: "criteria.requirements must be a non-empty array" }, { status: 400 });
    }
    if (criteria.requirements.length > 50) {
      return NextResponse.json({ error: "Too many criteria — max 50" }, { status: 400 });
    }
    for (const r of criteria.requirements) {
      if (typeof r !== "string" || r.trim() === "") {
        return NextResponse.json({ error: "Each requirement must be a non-empty string" }, { status: 400 });
      }
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (job.status !== "FUNDED") {
      return NextResponse.json({ error: "Job must be FUNDED before opening a nanopayment stream" }, { status: 400 });
    }
    if (job.budget <= 0n) {
      return NextResponse.json({ error: "Job budget must be > 0" }, { status: 400 });
    }
    if (!job.providerSCA || job.providerSCA === "0x0000000000000000000000000000000000000000") {
      return NextResponse.json({ error: "Job has no worker (providerSCA) assigned" }, { status: 400 });
    }

    // Authorization: caller must control the job's client (poster)
    const actor = await verifyCallerControlsAddress(req, job.clientSCA);
    if (!actor) {
      return NextResponse.json({ error: "You do not control this job's client wallet." }, { status: 403 });
    }

    const trancheCount = criteria.requirements.length;
    const totalBudget = job.budget.toString();
    const trancheAmounts = computeTrancheAmounts(job.budget, trancheCount);

    // 1) Approve USDC to the stream contract
    const approveTx = await createContractTransaction(
      job.clientSCA,
      USDC_CONTRACT,
      "approve(address,uint256)",
      [ARC_FLARE_STREAM_CONTRACT_ADDRESS, totalBudget],
      "approve USDC for nanopayment stream"
    );

    // 2) Open the stream on-chain
    const openTx = await createContractTransaction(
      job.clientSCA,
      ARC_FLARE_STREAM_CONTRACT_ADDRESS,
      "openStream(address,address,uint256,uint256)",
      [job.providerSCA, USDC_CONTRACT, totalBudget, trancheCount.toString()],
      "open nanopayment stream"
    );

    // 3) Parse streamId from the StreamOpened event
    const receipt = await publicClient.waitForTransactionReceipt({ hash: openTx as `0x${string}` });
    const streamOpenedLog = receipt.logs.find(
      (log) => log.address.toLowerCase() === ARC_FLARE_STREAM_CONTRACT_ADDRESS.toLowerCase()
    );
    if (!streamOpenedLog) {
      throw new Error("StreamOpened event not found in receipt");
    }
    const parsed = streamIface.parseLog({ topics: [...streamOpenedLog.topics], data: streamOpenedLog.data });
    if (!parsed || parsed.name !== "StreamOpened") {
      throw new Error("StreamOpened event parse failed");
    }
    const streamId = parsed.args.streamId.toString();

    // 4) Record in DB (idempotent)
    const record = await recordNanopaymentStreamOpened({
      jobId: jobId.toString(),
      txHash: openTx,
      streamId,
      workerAddress: job.providerSCA,
      token: USDC_CONTRACT,
      totalBudget,
      criteria,
    });

    return NextResponse.json({
      success: true,
      jobId,
      streamId,
      trancheCount,
      totalBudget,
      trancheAmounts: trancheAmounts.map((a) => a.toString()),
      txHash: openTx,
      replayed: record.replayed,
    });
  } catch (error: any) {
    console.error("Nanopay open error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(openHandler);