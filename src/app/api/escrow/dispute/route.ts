// src/app/api/escrow/dispute/route.ts
// Raises a dispute on an active escrow.
// Admin can then resolve via resolveDispute on the contract.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || "";

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string
): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === "FAILED") {
      throw new Error("Dispute transaction failed onchain.");
    }
  }
  throw new Error("Dispute transaction timed out.");
}

async function disputeHandler(request: Request) {
  try {
    const { reference, callerSCA, reason } = await request.json();

    if (!reference || !callerSCA) {
      return NextResponse.json(
        { success: false, error: "reference and callerSCA are required." },
        { status: 400 }
      );
    }

    const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
    if (!escrow) {
      return NextResponse.json({ success: false, error: "Escrow not found." }, { status: 404 });
    }
    if (escrow.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: `Escrow is ${escrow.status} — cannot dispute.` },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();

    // Call dispute() on the escrow contract
    const disputeTx = await circleClient.createContractExecutionTransaction({
      walletAddress: callerSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: ESCROW_CONTRACT,
      abiFunctionSignature: "dispute(bytes32)",
      abiParameters: [escrow.onchainId || reference],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txHash = await waitForCircleTx(circleClient, disputeTx.data?.id!);

    const updated = await (prisma as any).escrow.update({
      where: { reference },
      data: {
        status: "DISPUTED",
        disputeReason: reason || "No reason provided",
        disputeTxHash: txHash,
        disputedBy: callerSCA,
      },
    });

    // Notify admin webhook if set
    if (escrow.webhookUrl) {
      fetch(escrow.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "escrow.disputed",
          reference,
          amount: escrow.amount,
          currency: escrow.currency,
          disputedBy: callerSCA,
          reason: reason || "No reason provided",
          txHash,
          disputedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      escrow: updated,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: "Dispute raised. ArcFlare admin will review and resolve.",
    });
  } catch (error: any) {
    console.error("Escrow dispute error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(disputeHandler);