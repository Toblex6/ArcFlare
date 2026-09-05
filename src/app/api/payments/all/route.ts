//src/app/api/payments/all/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { resolveRowCurrency, tokenAddressFor } from '@/src/lib/tokens/resolveCurrency';

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

    const formattedPayments = paymentLogs.map((log) => {
      // The stored `status` never updates itself over time — a PENDING
      // link that's past its expiresAt is still stored as "PENDING"
      // forever unless someone actually attempts to settle it (which is
      // the only place expiry was ever checked). Derive the real status
      // here instead, so the table reflects reality without needing a
      // background job to flip rows.
      const isExpired =
        log.status === 'PENDING' && log.expiresAt != null && new Date() > log.expiresAt;
      const displayStatus = isExpired ? 'EXPIRED' : log.status;

      // Canonical settlement-token identity. Legacy rows default to USDC;
      // unsupported historical data degrades to USDC rather than failing the
      // whole merchant payment view.
      let token: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
      try {
        token = resolveRowCurrency({ currency: log.currency, tokenAddress: (log as any).tokenAddress });
      } catch {
        token = { symbol: 'USDC', address: tokenAddressFor('USDC'), decimals: 6 };
      }

      return {
        id: log.id,
        reference: log.reference,
        amount: log.amount || 0,
        currency: log.currency || 'USDC',
        chain: log.chain || 'Arc Testnet',
        status: displayStatus,
        rawStatus: log.status,
        displayStatus,
        isExpired,
        expiresAt: (log as any).expiresAt ?? null,
        sender_email: log.senderEmail || null,
        merchant: log.merchant || null,
        // Ensure date is a string to prevent serialization errors
        paid_at: (log.timestamp || new Date()).toISOString(),
        arc_tx_hash: log.arcTxHash || null,
        explorer_url: log.arcTxHash ? `https://testnet.arcscan.app/tx/${log.arcTxHash}` : null,
        gateway_reference: (log as any).gatewayReference || null,
        // Canonical settlement-token identity (additive).
        token,
        // No real CCTP telemetry (nonce, attestation status) is tracked anywhere
        // in the schema today — the block that used to be here was fabricated
        // (Math.random() nonce, hardcoded source/target domains) and has been
        // removed rather than left in place. If real CCTP domain/nonce data
        // becomes available (e.g. from cctp.ts/cctp-v2.ts), surface it here honestly.
      };
    });

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