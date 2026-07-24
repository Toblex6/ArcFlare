//src/app/api/payments/all/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const merchant = await resolveMerchant(req);
    if (!merchant) {
      return NextResponse.json(
        { status: false, error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const paymentLogs = await prisma.paymentLog.findMany({
      where: { merchantId: merchant.id },
      orderBy: {
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
      chain: log.chain || 'Arc Testnet',
      status: log.status,
      sender_email: log.senderEmail || 'autonomous-agent@bot.network',
      merchant: log.merchant || 'Dispatch Marketplace',
      // Ensure date is a string to prevent serialization errors
      paid_at: (log.timestamp || new Date()).toISOString(),
      arcTxHash: log.arcTxHash || null,
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
