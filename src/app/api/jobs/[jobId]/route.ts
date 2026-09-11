import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { agenticCommerceAbi, JOB_STATUS } from '@/lib/contracts/erc8183';
import { createPublicClient, http, formatUnits } from 'viem';
import { getArcChain, getNetworkConfig } from '@/lib/config/network';
const arcTestnet = getArcChain();
// ERC-8183 contract address resolves from the authoritative network config.
const ERC8183_ADDRESS = getNetworkConfig().erc8183Address as `0x${string}`;

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    // Malformed jobIds are a caller error (400), not a server error — the
    // same invalid-jobId contract as the canonical accept/fund routes.
    let jobIdBig: bigint;
    try {
      jobIdBig = BigInt(jobId);
    } catch {
      return NextResponse.json({ error: `invalid job id ${jobId}` }, { status: 400 });
    }
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

    const onchainJob = (await publicClient.readContract({
      address: ERC8183_ADDRESS,
      abi: agenticCommerceAbi,
      functionName: 'getJob',
      args: [jobIdBig],
    })) as any;

    const dbJob = await prisma.erc8183Job.findUnique({ where: { jobId: jobIdBig } });

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
        status: JOB_STATUS[Number(onchainJob.status) as keyof typeof JOB_STATUS] || 'UNKNOWN',
        statusCode: Number(onchainJob.status),
        hook: onchainJob.hook,
      },
      database: dbJob
        ? {
            deliverableHash: dbJob.deliverableHash,
            reasonHash: dbJob.reasonHash,
            txHashes: dbJob.txHashes,
            createdAt: dbJob.createdAt,
          }
        : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
