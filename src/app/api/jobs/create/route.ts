import { NextRequest, NextResponse } from "next/server";
import { getCircleClient, waitForTransaction } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from "@/lib/contracts/erc8183";
import { prisma } from "@/lib/prisma";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clientWalletId, providerAddress, evaluatorAddress, description } = body;

    if (!clientWalletId || !providerAddress || !evaluatorAddress || !description) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const circleClient = getCircleClient();
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

    const wallet = await circleClient.getWallet({ id: clientWalletId });
    const clientAddress = wallet.data?.wallet?.address;
    if (!clientAddress) {
      return NextResponse.json({ error: "Invalid client wallet ID" }, { status: 400 });
    }

    const expiredAt = Math.floor(Date.now() / 1000) + 3600;

    const createTx = await circleClient.createContractExecutionTransaction({
      walletAddress: clientAddress,
      blockchain: "ARC-TESTNET",
      contractAddress: AGENTIC_COMMERCE_CONTRACT,
      abiFunctionSignature: "createJob(address,address,uint256,string,address)",
      abiParameters: [providerAddress, evaluatorAddress, expiredAt.toString(), description, "0x0000000000000000000000000000000000000000"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTransaction(createTx.data?.id!, "create job");

    const nextJobId = await publicClient.readContract({
      address: AGENTIC_COMMERCE_CONTRACT,
      abi: agenticCommerceAbi as any,
      functionName: "jobCounter",
    }) as bigint;
    const jobId = nextJobId - 1n;

    const job = await prisma.erc8183Job.create({
      data: {
        jobId,
        clientSCA: clientAddress,
        providerSCA: providerAddress,
        evaluatorSCA: evaluatorAddress,
        description,
        budget: 0n,
        status: "OPEN",
        txHashes: [txHash],
        expiredAt: new Date(expiredAt * 1000),
      },
    });

    return NextResponse.json({
      success: true,
      jobId: jobId.toString(),
      dbId: job.id,
      txHash,
      status: "OPEN",
    });
  } catch (error: any) {
    console.error("Create job error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
