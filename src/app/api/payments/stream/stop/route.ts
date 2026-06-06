// src/app/api/payments/stream/stop/route.ts
// Stops an active stream by reading the streamId from the StreamCreated event log.
// Sender gets refund of unused USDC. Receiver gets all earned USDC up to stop time.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, decodeEventLog } from "viem";

const STREAM_CONTRACT = process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || "";

// Arc Testnet public RPC
const arcTestnet = {
  id: 7777777,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

// ABI for the StreamCreated event only — enough to decode the log
const STREAM_ABI = [
  {
    type: "event",
    name: "StreamCreated",
    inputs: [
      { name: "streamId", type: "bytes32", indexed: true },
      { name: "sender",   type: "address", indexed: false },
      { name: "receiver", type: "address", indexed: false },
      { name: "ratePerSecond",  type: "uint256", indexed: false },
      { name: "totalDeposited", type: "uint256", indexed: false },
      { name: "ref",  type: "string",  indexed: false },
    ],
  },
  {
    type: "function",
    name: "stopStream",
    inputs: [{ name: "streamId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

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

/**
 * Reads the StreamCreated event from the original createStream tx receipt
 * and extracts the bytes32 streamId the contract generated.
 */
async function getContractStreamId(txHash: string): Promise<`0x${string}`> {
  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: STREAM_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "StreamCreated") {
        // streamId is the first indexed topic (topics[1])
        return log.topics[1] as `0x${string}`;
      }
    } catch {
      // not this log, continue
    }
  }

  throw new Error(
    `Could not find StreamCreated event in tx ${txHash}. ` +
    `Make sure ARCFLARE_STREAM_CONTRACT_ADDRESS matches the deployed contract.`
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
        { success: false, error: "ARCFLARE_STREAM_CONTRACT_ADDRESS not set." },
        { status: 500 }
      );
    }

    // Load stream from DB
    const stream = await prisma.stream.findUnique({ where: { reference } });
    if (!stream) {
      return NextResponse.json(
        { success: false, error: "Stream not found." },
        { status: 404 }
      );
    }
    if (stream.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: `Stream is already ${stream.status}.` },
        { status: 400 }
      );
    }
    if (!stream.txHash) {
      return NextResponse.json(
        { success: false, error: "Stream has no txHash — cannot look up contract streamId." },
        { status: 400 }
      );
    }

    // ── Get the bytes32 streamId from the original tx receipt ────────────
    console.log(`🔍 Reading StreamCreated event from tx: ${stream.txHash}`);
    const contractStreamId = await getContractStreamId(stream.txHash);
    console.log(`✅ Contract streamId: ${contractStreamId}`);

    // ── Calculate earnings at stop time ───────────────────────────────────
    const now = Date.now();
    const elapsedSeconds = (now - new Date(stream.startedAt).getTime()) / 1000;
    const earned = Math.min(stream.ratePerSecond * elapsedSeconds, stream.totalDeposited);
    const refundAmount = Math.max(0, stream.totalDeposited - earned);

    // ── Call stopStream on the contract ───────────────────────────────────
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
    console.log(`✅ Stream stopped on Arc. Tx: ${stopTxHash}`);

    // ── Update DB ─────────────────────────────────────────────────────────
    const updated = await prisma.stream.update({
      where: { reference },
      data: {
        status: "STOPPED",
        totalStreamed: parseFloat(earned.toFixed(6)),
        stoppedAt: new Date(),
      },
    });

    // ── Fire webhook ──────────────────────────────────────────────────────
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
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(stopStreamHandler);
