import { NextRequest, NextResponse } from "next/server";
import { getCircleClient, createContractTransaction } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT, USDC_CONTRACT } from "@/lib/contracts/erc8183";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const { jobId, clientWalletId } = await req.json();
    if (!jobId || !clientWalletId) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: clientWalletId });
    const clientAddress = wallet.data?.wallet?.address;
    if (!clientAddress) {
      return NextResponse.json({ error: "Invalid client wallet" }, { status: 400 });
    }

    // Approve USDC
    const approveTx = await createContractTransaction(
      clientAddress,
      USDC_CONTRACT,
      "approve(address,uint256)",
      [AGENTIC_COMMERCE_CONTRACT, job.budget.toString()],
      "approve USDC"
    );

    // Fund escrow
    const fundTx = await createContractTransaction(
      clientAddress,
      AGENTIC_COMMERCE_CONTRACT,
      "fund(uint256,bytes)",
      [jobId, "0x"],
      "fund escrow"
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: "FUNDED", txHashes: { push: [approveTx, fundTx] } },
    });

    return NextResponse.json({ success: true, jobId, status: "FUNDED", approveTx, fundTx });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
