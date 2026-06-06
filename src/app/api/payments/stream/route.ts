// src/app/api/payments/stream/route.ts
// Base stream endpoint.
// POST → creates a new USDC payment stream on Arc Testnet
// GET  → lists all streams with live metrics (no auth required for GET)
//
// Sub-routes:
//   POST /api/payments/stream/stop      → stop an active stream
//   POST /api/payments/stream/withdraw  → receiver withdraws earned USDC

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

// ─── POST /api/payments/stream — Create a new stream ─────────────────────────
async function createStreamHandler(request: Request) {
  try {
    const body = await request.json();
    const {
      senderSCA,      // Circle SCA wallet address of sender
      receiverSCA,    // Recipient SCA wallet address
      ratePerSecond,  // USDC per second e.g. "0.001"
      totalDeposited, // Total USDC to lock e.g. "10.00"
      webhookUrl,
    } = body;

    // ── Validation ────────────────────────────────────────────────────────
    if (!senderSCA || !receiverSCA || !ratePerSecond || !totalDeposited) {
      return NextResponse.json(
        {
          success: false,
          error: "senderSCA, receiverSCA, ratePerSecond and totalDeposited are all required.",
          hint: {
            example: {
              senderSCA: "0xYourSenderSCAWallet",
              receiverSCA: "0xYourReceiverSCAWallet",
              ratePerSecond: "0.001",
              totalDeposited: "10.00",
              webhookUrl: "https://yoursite.com/webhook (optional)",
            },
          },
        },
        { status: 400 }
      );
    }

    if (!STREAM_CONTRACT) {
      return NextResponse.json(
        {
          success: false,
          error: "ARCFLARE_STREAM_CONTRACT_ADDRESS is not set in Render environment variables.",
          hint: "Add ARCFLARE_STREAM_CONTRACT_ADDRESS to your Render env vars once you deploy ArcFlareStream.sol.",
        },
        { status: 500 }
      );
    }

    const rateNum = parseFloat(ratePerSecond);
    const depositNum = parseFloat(totalDeposited);

    if (isNaN(rateNum) || rateNum <= 0) {
      return NextResponse.json(
        { success: false, error: "ratePerSecond must be a positive number." },
        { status: 400 }
      );
    }
    if (isNaN(depositNum) || depositNum <= 0) {
      return NextResponse.json(
        { success: false, error: "totalDeposited must be a positive number." },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();
    const reference = `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Convert to 6-decimal USDC units (USDC uses 6 decimals)
    const rateWei = parseUnits(ratePerSecond.toString(), 6);
    const depositWei = parseUnits(totalDeposited.toString(), 6);

    // Calculate stream duration
    const durationSeconds = depositNum / rateNum;
    const estimatedEndTime = new Date(Date.now() + durationSeconds * 1000);

    console.log(`🚀 Creating stream: ${ratePerSecond} USDC/s for ${durationSeconds}s | ref: ${reference}`);

    // ── Step 1: Approve stream contract to spend USDC ─────────────────────
    console.log("⏳ Step 1/2: Approving USDC spend...");
    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress: senderSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [STREAM_CONTRACT, depositWei.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    if (!approveTx.data?.id) {
      throw new Error("Circle approval transaction returned no ID.");
    }

    await waitForCircleTx(circleClient, approveTx.data.id);
    console.log("✅ USDC approval confirmed");

    // ── Step 2: Create the stream on Arc ─────────────────────────────────
    console.log("⏳ Step 2/2: Creating stream on Arc Testnet...");
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

    if (!streamTx.data?.id) {
      throw new Error("Circle stream transaction returned no ID.");
    }

    const streamTxHash = await waitForCircleTx(circleClient, streamTx.data.id);
    console.log(`✅ Stream live on Arc. TxHash: ${streamTxHash}`);

    // ── Step 3: Persist to Postgres ───────────────────────────────────────
    const streamRecord = await prisma.stream.create({
      data: {
        reference,
        senderSCA,
        receiverSCA,
        ratePerSecond: rateNum,
        totalDeposited: depositNum,
        totalStreamed: 0,
        currency: "USDC",
        status: "ACTIVE",
        contractAddress: STREAM_CONTRACT,
        txHash: streamTxHash,
        webhookUrl: webhookUrl || null,
      },
    });

    // ── Step 4: Fire webhook (non-blocking) ───────────────────────────────
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "stream.created",
          reference,
          senderSCA,
          receiverSCA,
          ratePerSecond: rateNum,
          totalDeposited: depositNum,
          currency: "USDC",
          estimatedDurationSeconds: durationSeconds,
          estimatedEndTime: estimatedEndTime.toISOString(),
          txHash: streamTxHash,
          explorerUrl: `https://testnet.arcscan.app/tx/${streamTxHash}`,
          createdAt: new Date().toISOString(),
        }),
      }).catch((e) => console.warn("Webhook delivery failed:", e.message));
    }

    return NextResponse.json({
      success: true,
      reference,
      stream: streamRecord,
      txHash: streamTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${streamTxHash}`,
      estimatedDurationSeconds: Math.floor(durationSeconds),
      estimatedEndTime: estimatedEndTime.toISOString(),
      nextSteps: {
        stop: `POST /api/payments/stream/stop   { reference, callerSCA }`,
        withdraw: `POST /api/payments/stream/withdraw { reference, receiverSCA }`,
        status: `GET  /api/payments/stream?sender=${senderSCA}`,
      },
      message: `Stream active — ${ratePerSecond} USDC/s flowing from ${senderSCA.slice(0, 10)}... to ${receiverSCA.slice(0, 10)}... on Arc Testnet.`,
    });
  } catch (error: any) {
    console.error("❌ Stream create error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// ─── GET /api/payments/stream — List streams with live metrics ────────────────
export const dynamic = "force-dynamic";

async function listStreamsHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sender   = searchParams.get("sender");
    const receiver = searchParams.get("receiver");
    const status   = searchParams.get("status");
    const ref      = searchParams.get("reference");

    const where: any = {};
    if (sender)   where.senderSCA   = sender;
    if (receiver) where.receiverSCA = receiver;
    if (status)   where.status      = status;
    if (ref)      where.reference   = ref;

    const streams = await prisma.stream.findMany({
      where,
      orderBy: { startedAt: "desc" },
    });

    const now = Date.now();

    const enriched = streams.map((s: any) => {
      // Only accumulate time while stream was active
      const endTime =
        s.status === "ACTIVE"
          ? now
          : s.stoppedAt
          ? new Date(s.stoppedAt).getTime()
          : now;

      const elapsedSeconds = Math.max(
        0,
        (endTime - new Date(s.startedAt).getTime()) / 1000
      );

      const streamed = Math.min(s.ratePerSecond * elapsedSeconds, s.totalDeposited);
      const remaining = Math.max(0, s.totalDeposited - streamed);
      const secondsRemaining =
        s.ratePerSecond > 0 ? remaining / s.ratePerSecond : 0;

      return {
        ...s,
        currentStreamed: parseFloat(streamed.toFixed(6)),
        remainingBalance: parseFloat(remaining.toFixed(6)),
        secondsRemaining: s.status !== "ACTIVE" ? 0 : Math.floor(secondsRemaining),
        percentComplete: parseFloat(
          Math.min((streamed / s.totalDeposited) * 100, 100).toFixed(2)
        ),
        explorerUrl: s.txHash
          ? `https://testnet.arcscan.app/tx/${s.txHash}`
          : null,
      };
    });

    // Aggregate metrics
    const activeStreams = enriched.filter((s: any) => s.status === "ACTIVE");
    const totalStreaming = activeStreams.reduce(
      (sum: number, s: any) => sum + s.remainingBalance,
      0
    );
    const totalRatePerSecond = activeStreams.reduce(
      (sum: number, s: any) => sum + s.ratePerSecond,
      0
    );

    return NextResponse.json({
      success: true,
      metrics: {
        total: streams.length,
        active: activeStreams.length,
        stopped: streams.filter((s: any) => s.status === "STOPPED").length,
        completed: streams.filter((s: any) => s.status === "COMPLETED").length,
        totalLockedUSDC: parseFloat(totalStreaming.toFixed(4)),
        totalRatePerSecond: parseFloat(totalRatePerSecond.toFixed(6)),
      },
      streams: enriched,
    });
  } catch (error: any) {
    console.error("❌ List streams error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(createStreamHandler);
export const GET  = withApiKey(listStreamsHandler);
