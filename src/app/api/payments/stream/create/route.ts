// src/app/api/payments/stream/route.ts
// Creates a USDC payment stream on Arc Testnet.
// USDC drips from sender to receiver per second via ArcFlareStream contract.
// Uses Circle SCA wallets and CCTP V2 USDC on Arc L1.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { parseUnits } from "viem";

const STREAM_CONTRACT = process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || "";
const USDC_ARC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string,
  maxAttempts = 30
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === "FAILED") {
      throw new Error("Stream transaction failed onchain.");
    }
  }
  throw new Error("Stream transaction polling timed out.");
}

async function createStreamHandler(request: Request) {
  try {
    const {
      senderSCA,         // Circle SCA wallet address of sender
      receiverSCA,       // Recipient SCA wallet address
      ratePerSecond,     // USDC per second as string e.g. "0.001" = 0.001 USDC/s
      totalDeposited,    // Total USDC to lock e.g. "10.00"
      webhookUrl,
    } = await request.json();

    if (!senderSCA || !receiverSCA || !ratePerSecond || !totalDeposited) {
      return NextResponse.json(
        { success: false, error: "senderSCA, receiverSCA, ratePerSecond and totalDeposited are required." },
        { status: 400 }
      );
    }

    if (!STREAM_CONTRACT) {
      return NextResponse.json(
        { success: false, error: "ARCFLARE_STREAM_CONTRACT_ADDRESS not set in environment." },
        { status: 500 }
      );
    }

    const circleClient = getCircleClient();
    const reference = `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Convert to 6 decimal USDC units
    const rateWei = parseUnits(ratePerSecond.toString(), 6);
    const depositWei = parseUnits(totalDeposited.toString(), 6);

    // Calculate stream duration
    const durationSeconds = Number(depositWei) / Number(rateWei);
    const estimatedEndTime = new Date(Date.now() + durationSeconds * 1000);

    // ── Step 1: Approve stream contract to spend USDC ─────────────────────
    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress: senderSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [STREAM_CONTRACT, depositWei.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    await waitForCircleTx(circleClient, approveTx.data?.id!);
    console.log("✅ USDC approval for stream confirmed");

    // ── Step 2: Create stream on Arc ──────────────────────────────────────
    const streamTx = await circleClient.createContractExecutionTransaction({
      walletAddress: senderSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: STREAM_CONTRACT,
      abiFunctionSignature: "createStream(address,uint256,uint256,string)",
      abiParameters: [
        receiverSCA,
        rateWei.toString(),
        depositWei.toString(),
        reference,
      ],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const streamTxHash = await waitForCircleTx(circleClient, streamTx.data?.id!);
    console.log(`✅ Stream created on Arc. Tx: ${streamTxHash}`);

    // ── Step 3: Save to Prisma ────────────────────────────────────────────
    const streamRecord = await prisma.stream.create({
      data: {
        reference,
        senderSCA,
        receiverSCA,
        ratePerSecond: parseFloat(ratePerSecond),
        totalDeposited: parseFloat(totalDeposited),
        totalStreamed: 0,
        currency: "USDC",
        status: "ACTIVE",
        contractAddress: STREAM_CONTRACT,
        txHash: streamTxHash,
        webhookUrl: webhookUrl || null,
      },
    });

    // Fire webhook
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "stream.created",
          reference,
          senderSCA,
          receiverSCA,
          ratePerSecond: parseFloat(ratePerSecond),
          totalDeposited: parseFloat(totalDeposited),
          estimatedDurationSeconds: durationSeconds,
          estimatedEndTime: estimatedEndTime.toISOString(),
          txHash: streamTxHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${streamTxHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      stream: streamRecord,
      txHash: streamTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${streamTxHash}`,
      estimatedDurationSeconds: durationSeconds,
      estimatedEndTime: estimatedEndTime.toISOString(),
      message: `Stream created — ${ratePerSecond} USDC/s flowing from ${senderSCA} to ${receiverSCA} on Arc Testnet.`,
    });
  } catch (error: any) {
    console.error("Stream create error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(createStreamHandler);

// ─── GET: List all streams or filter by sender/receiver ───────────────────────
export const dynamic = "force-dynamic";

async function listStreamsHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sender = searchParams.get("sender");
    const receiver = searchParams.get("receiver");
    const status = searchParams.get("status");

    const where: any = {};
    if (sender) where.senderSCA = sender;
    if (receiver) where.receiverSCA = receiver;
    if (status) where.status = status;

    const streams = await prisma.stream.findMany({
      where,
      orderBy: { startedAt: "desc" },
    });

    const now = Date.now();
    const enriched = streams.map((s: any) => {
      // Lock evaluation window if the stream was already stopped or finalized
      const endTime = s.status === "ACTIVE" ? now : (s.stoppedAt ? new Date(s.stoppedAt).getTime() : now);
      const elapsedSeconds = Math.max(0, (endTime - new Date(s.startedAt).getTime()) / 1000);
      
      const streamed = Math.min(
        s.ratePerSecond * elapsedSeconds,
        s.totalDeposited
      );
      const remaining = Math.max(0, s.totalDeposited - streamed);
      const secondsRemaining = s.ratePerSecond > 0 ? remaining / s.ratePerSecond : 0;

      return {
        ...s,
        currentStreamed: parseFloat(streamed.toFixed(6)),
        remainingBalance: parseFloat(remaining.toFixed(6)),
        secondsRemaining: s.status !== "ACTIVE" ? 0 : Math.floor(secondsRemaining),
        explorerUrl: s.txHash
          ? `https://testnet.arcscan.app/tx/${s.txHash}`
          : null,
      };
    });

    // Calculate aggregated active balances safely
    const totalStreaming = enriched
      .filter((s: any) => s.status === "ACTIVE")
      .reduce((sum: number, s: any) => sum + s.remainingBalance, 0);

    return NextResponse.json({
      success: true,
      metrics: {
        total: streams.length,
        active: streams.filter((s: any) => s.status === "ACTIVE").length,
        stopped: streams.filter((s: any) => s.status === "STOPPED").length,
        completed: streams.filter((s: any) => s.status === "COMPLETED").length,
        totalStreaming: parseFloat(totalStreaming.toFixed(4)),
      },
      streams: enriched,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const GET = withApiKey(listStreamsHandler);