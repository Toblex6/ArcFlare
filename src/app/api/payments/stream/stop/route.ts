// src/app/api/payments/stream/stop/route.ts

import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { withApiKey } from "@/src/lib/middleware/withApiKey";
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

// ── EXACT ABI matching your deployed ArcFlareStream.sol ──────────────────────
// StreamCreated has 3 indexed params: streamId, sender, receiver
const STREAM_CREATED_EVENT = {
  type: "event",
  name: "StreamCreated",
  inputs: [
    { name: "streamId",       type: "bytes32", indexed: true  },
    { name: "sender",         type: "address", indexed: true  },
    { name: "receiver",       type: "address", indexed: true  },
    { name: "ratePerSecond",  type: "uint256", indexed: false },
    { name: "totalDeposited", type: "uint256", indexed: false },
    { name: "ref",            type: "string",  indexed: false },
  ],
} as const;

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

// ── Read streamId from tx receipt logs ───────────────────────────────────────
// streamId is topics[1] since it's the first indexed param
async function getStreamIdFromReceipt(txHash: string): Promise<`0x${string}`> {
  console.log(`🔍 Fetching receipt for tx: ${txHash}`);

  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  console.log(`📋 Receipt has ${receipt.logs.length} logs`);

  // Log all topics for debugging
  receipt.logs.forEach((log, i) => {
    console.log(`Log ${i}: address=${log.address}, topics=${JSON.stringify(log.topics)}`);
  });

  // Find the log from our stream contract
  const contractAddress = STREAM_CONTRACT.toLowerCase();

  for (const log of receipt.logs) {
    // Match log from stream contract
    if (log.address.toLowerCase() !== contractAddress) continue;

    // StreamCreated has 4 topics: eventSig + streamId + sender + receiver
    if (log.topics.length !== 4) continue;

    // topics[1] is the streamId (first indexed param)
    const streamId = log.topics[1] as `0x${string}`;
    console.log(`✅ Found streamId: ${streamId}`);
    return streamId;
  }

  // Fallback: try any log with 4 topics (in case contract address check fails)
  for (const log of receipt.logs) {
    if (log.topics.length === 4) {
      const streamId = log.topics[1] as `0x${string}`;
      console.log(`⚠️ Fallback streamId from log: ${streamId}`);
      return streamId;
    }
  }

  throw new Error(
    `Could not find StreamCreated event in tx ${txHash}. ` +
    `Contract address in DB: ${STREAM_CONTRACT}. ` +
    `Logs found: ${receipt.logs.length}. ` +
    `Check that ARCFLARE_STREAM_CONTRACT_ADDRESS matches your deployed contract.`
  );
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

    if (!STREAM_CONTRACT) {
      return NextResponse.json(
        { success: false, error: "ARCFLARE_STREAM_CONTRACT_ADDRESS not set in environment." },
        { status: 500 }
      );
    }

    const stream = await prisma.stream.findUnique({ where: { reference } });
    if (!stream) {
      return NextResponse.json({ success: false, error: "Stream not found." }, { status: 404 });
    }
    if (stream.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: `Stream is already ${stream.status}.` },
        { status: 400 }
      );
    }
    if (!stream.txHash) {
      return NextResponse.json(
        { success: false, error: "Stream has no txHash." },
        { status: 400 }
      );
    }

    // Get bytes32 streamId from original createStream tx
    const contractStreamId = await getStreamIdFromReceipt(stream.txHash);

    // Calculate earnings
    const now = Date.now();
    const elapsedSeconds = (now - new Date(stream.startedAt).getTime()) / 1000;
    const earned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
    const refundAmount = Math.max(0, stream.totalDeposited - earned);

    const circleClient = getCircleClient();

    const stopTx = await circleClient.createContractExecutionTransaction({
      walletAddress: callerSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: STREAM_CONTRACT,
      abiFunctionSignature: "stopStream(bytes32)",
      abiParameters: [contractStreamId],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    if (!stopTx.data?.id) {
      throw new Error("Circle stop transaction returned no ID.");
    }

    const stopTxHash = await waitForCircleTx(circleClient, stopTx.data.id);
    console.log(`✅ Stream stopped. Tx: ${stopTxHash}`);

    const updated = await prisma.stream.update({
      where: { reference },
      data: {
        status: "STOPPED",
        totalStreamed: parseFloat(earned.toFixed(6)),
        stoppedAt: new Date(),
      },
    });

    if (stream.webhookUrl) {
      fetch(stream.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "stream.stopped",
          reference,
          totalStreamed: parseFloat(earned.toFixed(6)),
          refundedToSender: parseFloat(refundAmount.toFixed(6)),
          txHash: stopTxHash,
          stoppedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${stopTxHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      stream: updated,
      txHash: stopTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${stopTxHash}`,
      totalStreamed: parseFloat(earned.toFixed(6)),
      refundedToSender: parseFloat(refundAmount.toFixed(6)),
      message: `Stream stopped — ${earned.toFixed(6)} USDC streamed, ${refundAmount.toFixed(6)} USDC refunded to sender.`,
    });
  } catch (error: any) {
    console.error("❌ Stop stream error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(stopStreamHandler);
