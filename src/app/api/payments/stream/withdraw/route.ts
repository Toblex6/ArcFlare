// src/app/api/payments/stream/withdraw/route.ts

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http } from "viem";

const STREAM_CONTRACT = process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || "";

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
    public:  { http: ["https://rpc.testnet.arc.network"] },
  },
} as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

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
      throw new Error("Withdraw transaction failed onchain.");
    }
  }
  throw new Error("Withdraw transaction timed out.");
}

// ── Same streamId extraction logic as stop route ──────────────────────────────
async function getStreamIdFromReceipt(txHash: string): Promise<`0x${string}`> {
  console.log(`🔍 Fetching receipt for tx: ${txHash}`);

  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  console.log(`📋 Receipt has ${receipt.logs.length} logs`);

  receipt.logs.forEach((log, i) => {
    console.log(`Log ${i}: address=${log.address}, topics=${JSON.stringify(log.topics)}`);
  });

  const contractAddress = STREAM_CONTRACT.toLowerCase();

  // First try: match by contract address + 4 topics
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress) continue;
    if (log.topics.length !== 4) continue;
    const streamId = log.topics[1] as `0x${string}`;
    console.log(`✅ Found streamId: ${streamId}`);
    return streamId;
  }

  // Fallback: any log with 4 topics
  for (const log of receipt.logs) {
    if (log.topics.length === 4) {
      const streamId = log.topics[1] as `0x${string}`;
      console.log(`⚠️ Fallback streamId: ${streamId}`);
      return streamId;
    }
  }

  throw new Error(
    `Could not find StreamCreated event in tx ${txHash}. ` +
    `Contract: ${STREAM_CONTRACT}. Logs: ${receipt.logs.length}.`
  );
}

async function withdrawHandler(request: Request) {
  try {
    const { reference, receiverSCA } = await request.json();

    if (!reference || !receiverSCA) {
      return NextResponse.json(
        { success: false, error: "reference and receiverSCA are required." },
        { status: 400 }
      );
    }

    if (!STREAM_CONTRACT) {
      return NextResponse.json(
        { success: false, error: "ARCFLARE_STREAM_CONTRACT_ADDRESS not set." },
        { status: 500 }
      );
    }

    const stream = await prisma.stream.findUnique({ where: { reference } });
    if (!stream) {
      return NextResponse.json({ success: false, error: "Stream not found." }, { status: 404 });
    }
    if (stream.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: `Stream is ${stream.status}.` },
        { status: 400 }
      );
    }
    if (!stream.txHash) {
      return NextResponse.json(
        { success: false, error: "Stream has no txHash." },
        { status: 400 }
      );
    }

    // Calculate available
    const now = Date.now();
    const elapsedSeconds = (now - new Date(stream.startedAt).getTime()) / 1000;
    const totalEarned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
    const available = Math.max(0, totalEarned - stream.totalStreamed);

    if (available <= 0) {
      return NextResponse.json(
        { success: false, error: "No USDC available to withdraw yet." },
        { status: 400 }
      );
    }

    // Get bytes32 streamId
    const contractStreamId = await getStreamIdFromReceipt(stream.txHash);

    const circleClient = getCircleClient();

    const withdrawTx = await circleClient.createContractExecutionTransaction({
      walletAddress: receiverSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: STREAM_CONTRACT,
      abiFunctionSignature: "withdraw(bytes32)",
      abiParameters: [contractStreamId],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    if (!withdrawTx.data?.id) {
      throw new Error("Circle withdraw transaction returned no ID.");
    }

    const txHash = await waitForCircleTx(circleClient, withdrawTx.data.id);

    const newTotalStreamed = stream.totalStreamed + available;
    const isCompleted = newTotalStreamed >= stream.totalDeposited;

    const updated = await prisma.stream.update({
      where: { reference },
      data: {
        totalStreamed: parseFloat(newTotalStreamed.toFixed(6)),
        status: isCompleted ? "COMPLETED" : "ACTIVE",
        stoppedAt: isCompleted ? new Date() : null,
      },
    });

    if (stream.webhookUrl) {
      fetch(stream.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: isCompleted ? "stream.completed" : "stream.withdrawn",
          reference,
          receiverSCA,
          amountWithdrawn: parseFloat(available.toFixed(6)),
          totalStreamed: parseFloat(newTotalStreamed.toFixed(6)),
          txHash,
          withdrawnAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      stream: updated,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      amountWithdrawn: parseFloat(available.toFixed(6)),
      totalStreamed: parseFloat(newTotalStreamed.toFixed(6)),
      completed: isCompleted,
      message: `${available.toFixed(6)} USDC withdrawn from stream.`,
    });
  } catch (error: any) {
    console.error("❌ Withdraw error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(withdrawHandler);
