// src/app/api/merchant/payment-link/route.ts
// Authenticated merchants create shareable payment links
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { resolveRowCurrency, tokenAddressFor } from '@/src/lib/tokens/resolveCurrency';
import { getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import { getNetworkConfig, getArcNetworkName } from '@/lib/config/network';
import { filterRowsForNetwork } from '@/src/lib/payments/chainFilter';
import { publicUrl } from '@/lib/publicOrigin';

// H5: central merchant auth (active + verified + sessionVersion).

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse;

    // H5: resolveMerchant enforces active + verified + sessionVersion.
    const authed = await resolveMerchant(req);
    if (!authed) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const merchant = await (prisma as any).merchant.findUnique({ where: { id: authed.id } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const { amount, currency, description, webhookUrl } = body;

    // M6: shared usdcAmount rule (decimal string, ≤6 decimals, >0, capped) —
    // no float drift into the frozen invoice row.
    const linkAmountStr = String(amount ?? "").trim();
    if (!/^\d+(\.\d{1,6})?$/.test(linkAmountStr) || !Number.isFinite(parseFloat(linkAmountStr)) || parseFloat(linkAmountStr) <= 0 || parseFloat(linkAmountStr) > 10_000_000) {
      return NextResponse.json(
        { success: false, error: 'amount must be a positive decimal (up to 6 decimals) not exceeding 10,000,000.' },
        { status: 400 }
      );
    }

    // Production merchant product: USDC-only settlement. Any client-supplied
    // currency (including a stored legacy EURC preference) is ignored — new
    // merchant links ALWAYS settle USDC at the canonical, network-correct
    // address. Internal multicurrency paths (consumer/agent initialize) are
    // untouched. Per-invoice token stays frozen at creation.
    let token: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
    try {
      const usdc = getTokenBySymbol('USDC');
      token = { symbol: 'USDC', address: usdc.address, decimals: usdc.decimals };
    } catch (tokenErr: any) {
      return NextResponse.json(
        { success: false, error: 'USDC settlement is unavailable on this network.' },
        { status: 500 }
      );
    }

    const reference = `arc_ref_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

    if (!merchant.walletAddress) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Your payout wallet is not set up yet. Visit your dashboard to finish wallet setup before creating payment links.',
        },
        { status: 400 }
      );
    }

    // Same gap as the consumer initialize route: this was never set, so
    // merchant links never functionally expired either. 24h default since
    // merchant links are closer to invoices than a quick P2P request.
    const EXPIRY_HOURS = 24;
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60_000);

    await prisma.paymentLog.create({
      data: {
        reference,
        amount: parseFloat(linkAmountStr),
        currency: token.symbol,
        tokenAddress: token.address,
        chain: getNetworkConfig().name === 'mainnet' ? 'Arc v1.0' : 'Arc Testnet v1.0',
        senderEmail: 'pending@checkout',
        merchant: merchant.businessName,
        merchantId: merchant.id,
        merchantSCA: merchant.walletAddress,
        status: 'PENDING',
        webhookUrl: webhookUrl || null,
        expiresAt,
      },
    });

    const checkoutUrl = publicUrl(`/checkout/${reference}`);

    return NextResponse.json({
      success: true,
      reference,
      checkoutUrl,
      amount: parseFloat(linkAmountStr),
      currency: token.symbol,
      token: {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
      },
      description: description || null,
      merchant: merchant.businessName,
      expiresIn: '24 hours',
    });
  } catch (error: any) {
    console.error('Payment link error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}

// List merchant's payment links
export async function GET(req: NextRequest) {
  try {
    const authed = await resolveMerchant(req);
    if (!authed) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }
    const merchant = await (prisma as any).merchant.findUnique({ where: { id: authed.id } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    // Production views (mainnet server) exclude historical testnet-chain
    // rows — preserved in the database, never shown as current links.
    const payments = filterRowsForNetwork(
      await prisma.paymentLog.findMany({
        where: { merchant: merchant.businessName },
        orderBy: { timestamp: 'desc' },
        take: 100,
      }),
      getArcNetworkName()
    );

    const now = Date.now();
    return NextResponse.json({
      success: true,
      links: payments.map((p) => {
        const isExpired =
          p.status === "PENDING" && (p as any).expiresAt != null && now > new Date((p as any).expiresAt).getTime();
        const displayStatus = isExpired ? "EXPIRED" : p.status;
        // Canonical settlement-token identity (additive); legacy rows
        // without tokenAddress read as USDC.
        let rowToken: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
        try {
          rowToken = resolveRowCurrency({ currency: p.currency, tokenAddress: (p as any).tokenAddress });
        } catch {
          rowToken = { symbol: 'USDC', address: tokenAddressFor('USDC'), decimals: 6 };
        }
        return {
          reference: p.reference,
          amount: p.amount,
          currency: p.currency,
          token: rowToken,
          status: displayStatus,
          rawStatus: p.status,
          displayStatus,
          isExpired,
          expiresAt: (p as any).expiresAt ?? null,
          checkoutUrl: publicUrl(`/checkout/${p.reference}`),
          createdAt: p.timestamp,
        };
      }),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}