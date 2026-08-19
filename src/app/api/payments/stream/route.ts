// src/app/api/payments/stream/route.ts
// Stream status endpoint.
// GET  → lists all streams with live metrics (ApiKey required)
//
// The POST handler that used to live here was DELETED (2026-08-19): it
// granted USDC allowances to a hardcoded, never-deployed contract address
// (contracts/ArcFlareStream.sol is 0 bytes) with no ownership check on
// senderSCA — any ApiKey holder could cause any custodial wallet to
// approve 0xc9BbeDFb… for an arbitrary amount. Use
//   POST /api/payments/stream/create   (ownership-checked, canonical)
// to create streams instead.
//
// Sub-routes:
//   POST /api/payments/stream/stop      → stop an active stream
//   POST /api/payments/stream/withdraw  → receiver withdraws earned USDC

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withApiKey } from '@/src/lib/middleware/withApiKey';

// ─── GET /api/payments/stream — List streams with live metrics ────────────────
export const dynamic = 'force-dynamic';

async function listStreamsHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sender = searchParams.get('sender');
    const receiver = searchParams.get('receiver');
    const status = searchParams.get('status');
    const ref = searchParams.get('reference');

    const where: any = {};
    if (sender) where.senderSCA = sender;
    if (receiver) where.receiverSCA = receiver;
    if (status) where.status = status;
    if (ref) where.reference = ref;

    const streams = await prisma.stream.findMany({
      where,
      orderBy: { startedAt: 'desc' },
    });

    const now = Date.now();

    const enriched = streams.map((s: any) => {
      // Only accumulate time while stream was active
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
        percentComplete: parseFloat(Math.min((streamed / s.totalDeposited) * 100, 100).toFixed(2)),
        explorerUrl: s.txHash ? `https://testnet.arcscan.app/tx/${s.txHash}` : null,
      };
    });

    // Aggregate metrics
    const activeStreams = enriched.filter((s: any) => s.status === 'ACTIVE');
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
        stopped: streams.filter((s: any) => s.status === 'STOPPED').length,
        completed: streams.filter((s: any) => s.status === 'COMPLETED').length,
        totalLockedUSDC: parseFloat(totalStreaming.toFixed(4)),
        totalRatePerSecond: parseFloat(totalRatePerSecond.toFixed(6)),
      },
      streams: enriched,
    });
  } catch (error: any) {
    console.error('❌ List streams error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(listStreamsHandler);
