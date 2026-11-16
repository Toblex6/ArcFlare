// src/app/api/payments/stream/create/route.ts
// Legacy per-second creation is unavailable. The deployed ArcFlareStream
// implements criterion-based openStream/releaseTranche/closeStream instead:
// /api/jobs/nanopay/open locks a job budget into criteria, not a drip rate.
// Do not translate these incompatible semantics or approve/deposit any funds.
// GET remains the existing read-only view of legacy stream records.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { explorerTxUrl } from '@/lib/config/network';
import { streamAddressOr503 } from '@/lib/stream/streamGuard';

async function createStreamHandler() {
  const streamGate = streamAddressOr503();
  if ('response' in streamGate) return streamGate.response;

  return NextResponse.json(
    {
      success: false,
      error: 'streaming create is not available',
      code: 'STREAM_ABI_CONFIG_CONFLICT',
      message: 'The deployed stream contract supports criterion-based job tranches, not per-second streaming. Use /api/jobs/nanopay/open with a funded job and acceptance criteria. No funds have moved.',
    },
    { status: 503 }
  );
}

export const POST = createStreamHandler;

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
