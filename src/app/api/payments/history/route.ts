import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';

// Force Next.js to treat this route as a dynamic live-data feed
export const dynamic = 'force-dynamic';

/**
 * GET Handler for ArcFlare's Live Ledger Activity Dashboard
 * Endpoint: /api/payments/history
 */
export async function GET() {
  try {
    // 1. Fetch the latest 50 agent micro-transactions from your paymentLog table
    const logs = await prisma.paymentLog.findMany({
      orderBy: {
        timestamp: 'desc', // Most recent transactions first
      },
      take: 50,
    });

    // 2. Use TypeScript's native 'typeof' inference to extract the exact schema type dynamically
    type LogRowType = Awaited<ReturnType<typeof prisma.paymentLog.findMany>>[number];

    // 3. Compute live aggregate ecosystem metrics using our inferred type
    const totalTransactions = logs.length;

    // Explicitly defining parameters via our dynamic model shape to clear strict-any flags
    const totalVolume = logs.reduce((sum: number, log: LogRowType) => sum + log.amount, 0);

    // Calculate simulated gas savings ($0.05 saved per signature micro-settlement challenge)
    const estimatedGasSavedUSD = totalTransactions * 0.05;

    // 4. Return the tracking feed structured for your Next.js/React layout page
    return NextResponse.json(
      {
        success: true,
        metrics: {
          totalTransactions,
          totalVolumeProcessed: parseFloat(totalVolume.toFixed(4)),
          estimatedGasSavedUSD: parseFloat(estimatedGasSavedUSD.toFixed(2)),
          settlementCurrency: 'USDC',
          primaryChain: 'Arc-L1',
        },
        transactions: logs.map((log: LogRowType) => ({
          id: log.id,
          reference: log.reference,
          amount: log.amount,
          currency: log.currency,
          chain: log.chain,
          senderEmail: log.senderEmail,
          merchant: log.merchant,
          status: log.status,
          timestamp: log.timestamp,
        })),
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ Ledger History API Failure:', error);
    return NextResponse.json(
      { success: false, error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}
