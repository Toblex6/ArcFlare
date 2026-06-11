import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi, JOB_STATUS } from "@/lib/contracts/erc8183";
import { createPublicClient, http, formatUnits } from "viem";
import { arcTestnet } from "viem/chains";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

    const onchainJob = await publicClient.readContract({
      address: AGENTIC_COMMERCE_CONTRACT,
      abi: agenticCommerceAbi,
      functionName: "getJob",
      args: [BigInt(jobId)],
    }) as any;

    const dbJob = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });

    return NextResponse.json({
      success: true,
      job: {
        id: jobId,
        client: onchainJob.client,
        provider: onchainJob.provider,
        evaluator: onchainJob.evaluator,
        description: onchainJob.description,
        budget: formatUnits(onchainJob.budget, 6),
        expiredAt: new Date(Number(onchainJob.expiredAt) * 1000).toISOString(),
        status: JOB_STATUS[Number(onchainJob.status) as keyof typeof JOB_STATUS] || "UNKNOWN",
        statusCode: Number(onchainJob.status),
        hook: onchainJob.hook,
      },
      database: dbJob ? {
        deliverableHash: dbJob.deliverableHash,
        reasonHash: dbJob.reasonHash,
        txHashes: dbJob.txHashes,
        createdAt: dbJob.createdAt,
      } : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
