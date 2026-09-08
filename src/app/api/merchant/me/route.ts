// src/app/api/merchant/me/route.ts
// Returns current merchant profile + their payments + API key hint
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { jwtVerify } from 'jose';
import { tryJwtSecret } from '@/src/lib/auth/secrets';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SettlementPreferenceSchema } from '@/src/lib/validation';
import { resolveMerchantSettlementPreference, resolvePreferenceUpdate } from '@/src/lib/routing/preference';
import { getTokenByAddress, getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';

const JWT_SECRET = tryJwtSecret('MERCHANT_JWT_SECRET');

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('merchant_token')?.value;
    if (!token || !JWT_SECRET) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const merchant = await (prisma as any).merchant.findUnique({
      where: { id: merchantId },
    });

    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    // Get their payments (matched by businessName in merchant field)
    const payments = await prisma.paymentLog.findMany({
      where: { merchant: merchant.businessName },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    // Explicit per-currency buckets — USDC and EURC are never summed as
    // fungible units. `totalVolume` is a DEPRECATED mixed-unit sum kept
    // for back-compat — prefer `volumeByCurrency`.
    const volumeByCurrency = { USDC: 0, EURC: 0 };
    for (const p of payments.filter((p) => p.status === 'SUCCESS')) {
      const symbol = String((p as any).currency ?? 'USDC').trim().toUpperCase();
      if (symbol === 'EURC') volumeByCurrency.EURC += (p as any).amount || 0;
      else volumeByCurrency.USDC += (p as any).amount || 0;
    }
    volumeByCurrency.USDC = parseFloat(volumeByCurrency.USDC.toFixed(4));
    volumeByCurrency.EURC = parseFloat(volumeByCurrency.EURC.toFixed(4));

    const totalVolume = volumeByCurrency.USDC + volumeByCurrency.EURC;

    const successCount = payments.filter((p) => p.status === 'SUCCESS').length;

    // Phase 6 (additive): current default settlement token for FUTURE
    // invoices, for the settings UI + payment-creation default. NULL =
    // USDC default. Fail-soft to USDC on a corrupt stored value so a bad
    // row can never 500 the dashboard — the PATCH path above still
    // validates strictly and refuses to persist non-canonical values.
    let preference: { symbol: string; address: string; decimals: number };
    try {
      preference = resolveMerchantSettlementPreference(merchant);
    } catch {
      const fallback = getTokenBySymbol('USDC');
      preference = { symbol: fallback.symbol, address: fallback.address, decimals: fallback.decimals };
    }

    return NextResponse.json({
      success: true,
      merchant: {
        id: merchant.id,
        email: merchant.email,
        businessName: merchant.businessName,
        createdAt: merchant.createdAt,
        walletProvider: merchant.walletProvider,
        walletAddress: merchant.walletAddress,
        // Show masked key — full key was shown only at signup
        apiKeyHint: `${merchant.apiKey.slice(0, 16)}...`,
      },
      settlementPreference: {
        symbol: preference.symbol,
        address: preference.address,
        decimals: preference.decimals,
      },
      stats: {
        totalPayments: payments.length,
        successfulPayments: successCount,
        // DEPRECATED mixed-unit sum — kept for back-compat. Use `volumeByCurrency`.
        totalVolume: parseFloat(totalVolume.toFixed(4)),
        volumeByCurrency,
        successRate:
          payments.length > 0 ? parseFloat(((successCount / payments.length) * 100).toFixed(1)) : 0,
      },
      recentPayments: payments.slice(0, 20).map((p) => ({
        reference: p.reference,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        timestamp: p.timestamp,
        checkoutUrl: `https://flarehq.xyz/checkout/${p.reference}`,
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}

// Logout
export async function DELETE(req: NextRequest) {
  const response = NextResponse.json({ success: true, message: 'Logged out.' });
  response.cookies.delete('merchant_token');
  return response;
}

// Update default settlement preference (Payment Routing v1). Sets the token
// FUTURE invoices settle in. Existing PaymentLog rows are frozen and are
// never touched here — only the merchant row is updated.
export async function PATCH(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const token = req.cookies.get('merchant_token')?.value;
    if (!token || !JWT_SECRET) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SettlementPreferenceSchema, body);
    if (validationError) return validationError as NextResponse;

    // Resolver-canonical: unsupported symbols, arbitrary addresses, and
    // symbol/address mismatches are rejected — never persisted.
    let canonicalAddress: string;
    try {
      canonicalAddress = resolvePreferenceUpdate({
        settlementToken: data.settlementToken,
        settlementTokenAddress: data.settlementTokenAddress,
      });
    } catch (prefErr: any) {
      return NextResponse.json({ success: false, error: prefErr.message }, { status: 400 });
    }

    const updated = await (prisma as any).merchant.update({
      where: { id: merchantId },
      data: { settlementTokenAddress: canonicalAddress },
    });
    const view = getTokenByAddress(canonicalAddress)!;

    return NextResponse.json({
      success: true,
      settlementPreference: {
        symbol: view.symbol,
        address: view.address,
        decimals: view.decimals,
      },
      merchantId: updated.id,
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}
