// src/app/api/payments/stream/stop/route.ts
// Stops an active stream. Sender gets refund of unused USDC.
// Receiver gets all earned USDC up to stop time.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const STREAM_CONTRACT = process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || "";

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
      throw new Error("Stop stream transaction failed onchain.");
    }
  }
  throw new Error("Stop stream transaction timed out.");
}

async function stopStreamHandler(request: Request) {
  try {
    const { reference, callerSCA } = await request.json();

    if (!reference || !callerSCA) {
      return NextResponse.json(
        { success: false, error: "reference and callerSCA are required." },
        { status: 400 }
      );
    }

    const stream = await prisma.stream.findUnique({ where: { reference } });
    if (!stream) {
      return NextResponse.json(
        { success: false, error: "Stream not found." },
        { status: 404 }
      );
    }
    if (stream.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: `Stream is ${stream.status} — cannot stop.` },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();

    // Calculate earnings at stop time
    const now = Date.now();
    const elapsedSeconds = (now - new Date(stream.startedAt).getTime()) / 1000;
    const earned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
    const refundAmount = Math.max(0, stream.totalDeposited - earned);

    // Call stopStream on the contract
    const stopTx = await circleClient.createContractExecutionTransaction({
      walletAddress: callerSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: STREAM_CONTRACT,
      abiFunctionSignature: "stopStream(bytes32)",
      abiParameters: [stream.txHash || reference],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txHash = await waitForCircleTx(circleClient, stopTx.data?.id!);
    console.log(`✅ Stream stopped. Tx: ${txHash}`);

    // Update DB
    const updated = await prisma.stream.update({
      where: { reference },
      data: {
        status: "STOPPED",
        totalStreamed: parseFloat(earned.toFixed(6)),
        stoppedAt: new Date(),
      },
    });

    // Fire webhook
    if (stream.webhookUrl) {
      fetch(stream.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "stream.stopped",
          reference,
          senderSCA: stream.senderSCA,
          receiverSCA: stream.receiverSCA,
          totalStreamed: parseFloat(earned.toFixed(6)),
          refundedToSender: parseFloat(refundAmount.toFixed(6)),
          currency: stream.currency,
          txHash,
          stoppedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      stream: updated,
      txHash,
      totalStreamed: parseFloat(earned.toFixed(6)),
      refundedToSender: parseFloat(refundAmount.toFixed(6)),
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Stream stopped — ${earned.toFixed(6)} USDC streamed, ${refundAmount.toFixed(6)} USDC refunded to sender.`,
    });
  } catch (error: any) {
    console.error("Stop stream error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(stopStreamHandler);