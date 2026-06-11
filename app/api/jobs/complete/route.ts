import { NextRequest, NextResponse } from "next/server";
import { getCircleClient, createContractTransaction } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT } from "@/lib/contracts/erc8183";
import { prisma } from "@/lib/prisma";
import { keccak256, toHex } from "viem";

export async function POST(req: NextRequest) {
  try {
    const { jobId, evaluatorWalletId, reason = "deliverable-approved" } = await req.json();
    if (!jobId || !evaluatorWalletId) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: evaluatorWalletId });
    const evaluatorAddress = wallet.data?.wallet?.address;
    if (!evaluatorAddress) {
      return NextResponse.json({ error: "Invalid evaluator wallet" }, { status: 400 });
    }

    const reasonHash = keccak256(toHex(reason));
    const txHash = await createContractTransaction(
      evaluatorAddress,
      AGENTIC_COMMERCE_CONTRACT,
      "complete(uint256,bytes32,bytes)",
      [jobId, reasonHash, "0x"],
      "complete job"
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: "COMPLETED", reasonHash, txHashes: { push: txHash } },
    });

    return NextResponse.json({ success: true, jobId, status: "COMPLETED", txHash });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
