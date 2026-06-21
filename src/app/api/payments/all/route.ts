import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const paymentLogs = await prisma.paymentLog.findMany({
      orderBy: {
        // Use 'createdAt' if 'timestamp' isn't in your schema
        timestamp: 'desc',
      },
    });

    const successfulLogs = paymentLogs.filter((log) => log.status === 'SUCCESS');

    const totalVolume = Number(
      successfulLogs.reduce((acc, log) => acc + (log.amount || 0), 0).toFixed(4)
    );

    const successRate =
      paymentLogs.length > 0 ? (successfulLogs.length / paymentLogs.length) * 100 : 100;

    const formattedPayments = paymentLogs.map((log) => ({
      id: log.id,
      reference: log.reference,
      amount: log.amount || 0,
      currency: log.currency || 'USDC',
      chain: log.chain || 'Arbitrum Sepolia ➔ Arc Testnet',
      status: log.status,
      sender_email: log.senderEmail || 'autonomous-agent@bot.network',
      merchant: log.merchant || 'Dispatch Marketplace',
      // Ensure date is a string to prevent serialization errors
      paid_at: (log.timestamp || new Date()).toISOString(),
      cctp_telemetry: {
        source_domain: 3,
        target_domain: 7,
        attestation_status:
          log.status === 'SUCCESS' ? 'REDEEMED_AND_MINTED' : 'POLLING_CIRCLE_TESTNET_IRIS_API',
        nonce: Math.floor(100000 + Math.random() * 800000),
      },
    }));

    return NextResponse.json({
      status: true,
      metrics: {
        totalVolume,
        successRate,
        totalTransactions: paymentLogs.length,
      },
      data: formattedPayments,
    });
  } catch (error: any) {
    console.error('❌ Bulk Metrics Ledger Read Exception:', error);
    return NextResponse.json(
      {
        status: false,
        error: 'Failed to pull transaction ledger matrix data',
        details: error.message,
      },
      { status: 500 }
    );
  }
}
