// src/app/api/payments/stream/create/route.ts
// Creates a USDC payment stream on Arc Testnet.
// USDC drips from sender to receiver per second via ArcFlareStream contract.
// Uses Circle SCA wallets and CCTP V2 USDC on Arc L1.
//
// NOTE: src/app/api/payments/stream/route.ts (POST) is a near-duplicate of
// this create logic with no internal callers found anywhere in the
// codebase — flagged for removal, not touched here since this file is the
// more complete canonical version (has both create and list).
//
// SECURITY: added ownership verification for senderSCA (was trusted
// outright). Same multi-step (approve + createStream) atomicity limitation
// as escrow/create applies — external-wallet senders aren't supported yet,
// stated plainly below rather than faked.

import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { parseUnits } from 'viem';
import { explorerTxUrl, getNetworkConfig } from "@/lib/config/network";
import { checkRateLimit } from '@/src/lib/ratelimit';
import { enforceSpendLimit } from '@/lib/agents/spendWindow';

const STREAM_CONTRACT = process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || '';
const USDC_ARC: string = getNetworkConfig().usdcAddress;

// ── Per-merchant stream ceilings (audit: spend-limit gap) ────────────────────
// ratePerSecond/totalDeposited were previously unbounded — a single accepted
// stream could lock an arbitrarily large deposit or drain the sender at an
// arbitrarily fast drip. Both are now bounded before the stream is accepted:
//   • max 10 USDC/s drip rate
//   • max 10,000 USDC total deposit per stream
//   • max 10 ACTIVE streams per sender (concurrent-stream accumulation cap)
const MAX_STREAM_RATE_PER_SECOND = 10;
const MAX_STREAM_TOTAL_DEPOSIT = 10_000;
const MAX_ACTIVE_STREAMS_PER_SENDER = 10;

const STREAM_AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

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
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === 'FAILED') {
      throw new Error('Stream transaction failed onchain.');
    }
  }
  throw new Error('Stream transaction polling timed out.');
}

async function createStreamHandler(request: NextRequest) {
  try {
    // H9: payments-tier rate limit on this fund-moving POST.
    const { allowed, response: limitResponse } = await checkRateLimit(request, 'payments');
    if (!allowed) return limitResponse!;
    // H12: the existing StreamCreateSchema is now enforced — scaAddress on
    // both endpoints, shared usdcAmount rule (≤6 decimals, >0, capped) on
    // both money fields, totalDeposited ≥ ratePerSecond. Unvalidated
    // parseUnits on raw body fields never reaches a sink.
    const raw = await request.json();
    const { parseBody, StreamCreateSchema } = await import('@/src/lib/validation');
    const { data, error: validationError } = parseBody(StreamCreateSchema, raw);
    if (validationError) {
      const msg = await (validationError as Response).json().catch(() => null);
      return NextResponse.json(
        { success: false, error: (msg as any)?.error ?? 'Validation failed.' },
        { status: 400 }
      );
    }
    const {
      senderSCA,
      receiverSCA,
      ratePerSecond,
      totalDeposited,
      webhookUrl,
    } = data;

    if (!STREAM_CONTRACT) {
      return NextResponse.json(
        { success: false, error: 'ARCFLARE_STREAM_CONTRACT_ADDRESS not set in environment.' },
        { status: 500 }
      );
    }

    // ── Ownership check — proves the caller actually controls senderSCA ────
    const actor = await verifyCallerControlsAddress(request, senderSCA);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the wallet named in senderSCA.' },
        { status: 403 }
      );
    }

    // ── Honest boundary — same reasoning as escrow/create: two sequential
    // contract calls can't be automated atomically for a plain EOA without
    // session delegation, which doesn't exist yet.
    if (actor.type === 'merchant') {
      const merchantRecord = await prisma.merchant.findUnique({ where: { id: actor.id } });
      if (merchantRecord && merchantRecord.walletProvider !== 'CIRCLE') {
        return NextResponse.json(
          {
            success: false,
            error: 'Creating a stream from an external wallet is not supported yet — this action requires two sequential onchain approvals (approve + createStream) that need session-key delegation to automate safely. Use a Circle-managed wallet for stream creation for now.',
          },
          { status: 501 }
        );
      }
    }

    const circleClient = getCircleClient();
    const reference = `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // ── Per-merchant stream ceilings (audit: spend-limit gap) — BEFORE the
    // approve tx. ratePerSecond/totalDeposited were unbounded before this
    // gate; both are now bounded, and the composed spend gate (on-chain
    // pre-flight + atomic per-payer DB window) bounds the payer's total
    // committed outflow so concurrent stream creations can't race past it.
    const rateNum = Number(ratePerSecond);
    const depositNum = Number(totalDeposited);
    if (!Number.isFinite(rateNum) || rateNum <= 0 || rateNum > MAX_STREAM_RATE_PER_SECOND) {
      return NextResponse.json(
        { success: false, error: `ratePerSecond must be a positive number up to ${MAX_STREAM_RATE_PER_SECOND} USDC/s.` },
        { status: 400 }
      );
    }
    if (!Number.isFinite(depositNum) || depositNum <= 0 || depositNum > MAX_STREAM_TOTAL_DEPOSIT) {
      return NextResponse.json(
        { success: false, error: `totalDeposited must be a positive number up to ${MAX_STREAM_TOTAL_DEPOSIT} USDC.` },
        { status: 400 }
      );
    }
    const activeStreamCount = await prisma.stream.count({
      where: { senderSCA, status: 'ACTIVE' },
    });
    if (activeStreamCount >= MAX_ACTIVE_STREAMS_PER_SENDER) {
      return NextResponse.json(
        { success: false, error: `Sender already has ${activeStreamCount} active streams (max ${MAX_ACTIVE_STREAMS_PER_SENDER}). Close one before opening another.` },
        { status: 403 }
      );
    }
    const streamSpendGate = await enforceSpendLimit({
      payerAddress: senderSCA,
      amountMicros: BigInt(Math.round(depositNum * 1e6)),
      context: `stream/create:${reference}`,
    });
    if (!streamSpendGate.allowed) {
      return NextResponse.json(
        { success: false, error: streamSpendGate.reason ?? 'Spend limit rejected.' },
        { status: 403 }
      );
    }

    // Convert to 6 decimal USDC units
    const rateWei = parseUnits(ratePerSecond.toString(), 6);
    const depositWei = parseUnits(totalDeposited.toString(), 6);

    // Calculate stream duration
    const durationSeconds = Number(depositWei) / Number(rateWei);
    const estimatedEndTime = new Date(Date.now() + durationSeconds * 1000);

    // ── Step 1: Approve stream contract to spend USDC ─────────────────────
    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress: senderSCA,
      blockchain: getNetworkConfig().circleBlockchain as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [STREAM_CONTRACT, depositWei.toString()],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    await waitForCircleTx(circleClient, approveTx.data?.id!);
    console.log('✅ USDC approval for stream confirmed');

    // ── Step 2: Create stream on Arc ──────────────────────────────────────
    const streamTx = await circleClient.createContractExecutionTransaction({
      walletAddress: senderSCA,
      blockchain: getNetworkConfig().circleBlockchain as any,
      contractAddress: STREAM_CONTRACT,
      abiFunctionSignature: 'createStream(address,uint256,uint256,string)',
      abiParameters: [receiverSCA, rateWei.toString(), depositWei.toString(), reference],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
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
        currency: 'USDC',
        status: 'ACTIVE',
        contractAddress: STREAM_CONTRACT,
        txHash: streamTxHash,
        webhookUrl: webhookUrl || null,
      },
    });

    // Fire webhook
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'stream.created',
          reference,
          senderSCA,
          receiverSCA,
          ratePerSecond: parseFloat(ratePerSecond),
          totalDeposited: parseFloat(totalDeposited),
          estimatedDurationSeconds: durationSeconds,
          estimatedEndTime: estimatedEndTime.toISOString(),
          txHash: streamTxHash,
          explorerUrl: `${explorerTxUrl(streamTxHash)}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      stream: streamRecord,
      txHash: streamTxHash,
      explorerUrl: `${explorerTxUrl(streamTxHash)}`,
      estimatedDurationSeconds: durationSeconds,
      estimatedEndTime: estimatedEndTime.toISOString(),
      message: `Stream created — ${ratePerSecond} USDC/s flowing from ${senderSCA} to ${receiverSCA} on ${getNetworkConfig().name === 'mainnet' ? 'Arc' : 'Arc Testnet'}.`,
    });
  } catch (error: any) {
    console.error('Stream create error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(createStreamHandler);

// ─── GET: List all streams or filter by sender/receiver ───────────────────────
export const dynamic = 'force-dynamic';

async function listStreamsHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sender = searchParams.get('sender');
    const receiver = searchParams.get('receiver');
    const status = searchParams.get('status');

    const where: any = {};
    if (sender) where.senderSCA = sender;
    if (receiver) where.receiverSCA = receiver;
    if (status) where.status = status;

    const streams = await prisma.stream.findMany({
      where,
      orderBy: { startedAt: 'desc' },
    });

    const now = Date.now();
    const enriched = streams.map((s: any) => {
      // Lock evaluation window if the stream was already stopped or finalized
      const endTime =
        s.status === 'ACTIVE' ? now : s.stoppedAt ? new Date(s.stoppedAt).getTime() : now;
      const elapsedSeconds = Math.max(0, (endTime - new Date(s.startedAt).getTime()) / 1000);

      const streamed = Math.min(s.ratePerSecond * elapsedSeconds, s.totalDeposited);
      const remaining = Math.max(0, s.totalDeposited - streamed);
      const secondsRemaining = s.ratePerSecond > 0 ? remaining / s.ratePerSecond : 0;

      return {
        ...s,
        currentStreamed: parseFloat(streamed.toFixed(6)),
        remainingBalance: parseFloat(remaining.toFixed(6)),
        secondsRemaining: s.status !== 'ACTIVE' ? 0 : Math.floor(secondsRemaining),
        explorerUrl: s.txHash ? `${explorerTxUrl(s.txHash)}` : null,
      };
    });

    // Calculate aggregated active balances safely
    const totalStreaming = enriched
      .filter((s: any) => s.status === 'ACTIVE')
      .reduce((sum: number, s: any) => sum + s.remainingBalance, 0);

    return NextResponse.json({
      success: true,
      metrics: {
        total: streams.length,
        active: streams.filter((s: any) => s.status === 'ACTIVE').length,
        stopped: streams.filter((s: any) => s.status === 'STOPPED').length,
        completed: streams.filter((s: any) => s.status === 'COMPLETED').length,
        totalStreaming: parseFloat(totalStreaming.toFixed(4)),
      },
      streams: enriched,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(listStreamsHandler);
