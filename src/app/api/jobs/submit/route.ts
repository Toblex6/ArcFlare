// src/app/api/jobs/submit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createContractTransaction, getCircleClient } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT } from "@/lib/contracts/erc8183";
import { prisma } from "@/lib/prisma";
import { keccak256, toHex } from "viem";

export async function POST(req: NextRequest) {
  try {
    const { jobId, providerWalletId, deliverableData } = await req.json();
    if (!jobId || !providerWalletId || !deliverableData) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: providerWalletId });
    const providerAddress = wallet.data?.wallet?.address;
    if (!providerAddress) {
      return NextResponse.json({ error: "Invalid provider wallet" }, { status: 400 });
    }

    const deliverableHash = keccak256(toHex(deliverableData));
    const txHash = await createContractTransaction(
      providerAddress,
      AGENTIC_COMMERCE_CONTRACT,
      "submit(uint256,bytes32,bytes)",
      [jobId, deliverableHash, "0x"],
      "submit deliverable"
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: "SUBMITTED", deliverableHash, txHashes: { push: txHash } },
    });

    return NextResponse.json({ success: true, jobId, status: "SUBMITTED", deliverableHash, txHash });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}