// src/app/api/merchant/me/route.ts
// Returns current merchant profile + their payments + API key hint
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SettlementPreferenceSchema } from '@/src/lib/validation';
import { resolveMerchantSettlementPreference, resolvePreferenceUpdate } from '@/src/lib/routing/preference';
import { getTokenByAddress, getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import { getArcNetworkName } from '@/lib/config/network';
import { filterRowsForNetwork } from '@/src/lib/payments/chainFilter';
import { publicUrl } from '@/lib/publicOrigin';

// H5: central merchant auth (active + verified + sessionVersion).

export async function GET(req: NextRequest) {
  // Safe timing diagnostic (Phase 4): durations only, no customer data. The
  // login route logs its own total under [merchant/login]; compare the two
  // to separate "login API slow" from "dashboard follow-up slow".
  const t0 = Date.now();
  try {
    // H5: resolveMerchant enforces active + verified + sessionVersion.
    const tAuth = Date.now();
    const authed = await resolveMerchant(req);
    const authMs = Date.now() - tAuth;
    if (!authed) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    // The profile row and the payment list are independent given authed.id —
    // run them concurrently instead of sequentially (one fewer DB round trip
    // on the dashboard's critical post-login path). Auth checks above stay
    // strictly before both reads.
    const tData = Date.now();
    const [merchant, rawPayments] = await Promise.all([
      (prisma as any).merchant.findUnique({
        where: { id: authed.id },
      }),
      prisma.paymentLog.findMany({
        where: { merchantId: authed.id },
        orderBy: { timestamp: 'desc' },
        take: 50,
      }),
    ]);
    const dataMs = Date.now() - tData;

    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    // Tenant isolation: payments are scoped by the authenticated merchant's ID
    // (merchantId FK), NEVER by businessName — businessName is a non-unique
    // display string shared by unrelated merchants, so name-scoping leaked
    // one merchant's payments/volume into another's dashboard.
    // Production views (mainnet server) exclude historical testnet-chain
    // rows — preserved in the database, never shown as current activity.
    const payments = filterRowsForNetwork(rawPayments, getArcNetworkName());
    console.log(
      `[merchant/me] totalMs=${Date.now() - t0} authMs=${authMs} dataMs=${dataMs} payments=${payments.length}`
    );

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
        // Show masked key — full key was shown only at signup. apiKey is NULL
        // for signed-up-but-unverified merchants (verify mints it), so guard
        // the slice — a null crash here used to surface as a misleading 401
        // "Invalid session" that bounced the merchant to the login page.
        apiKeyHint: merchant.apiKey ? `${String(merchant.apiKey).slice(0, 16)}...` : null,
        hasApiKey: merchant.apiKey != null,
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
        checkoutUrl: publicUrl(`/checkout/${p.reference}`),
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}

// Logout — server-side invalidation: bump sessionVersion so any outstanding
// merchant_token (including the one being logged out, and any stolen copy)
// stops passing resolveMerchant's sessionVersion check. The cookie is always
// cleared, even when there is no resolvable session.
export async function DELETE(req: NextRequest) {
  try {
    const authed = await resolveMerchant(req);
    if (authed) {
      await (prisma as any).merchant
        .update({ where: { id: authed.id }, data: { sessionVersion: { increment: 1 } } })
        .catch(() => null);
    }
  } catch {
    // Logout never throws — the cookie is still cleared below.
  }
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

    const authed = await resolveMerchant(req);
    if (!authed) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const merchant = await (prisma as any).merchant.findUnique({ where: { id: authed.id } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SettlementPreferenceSchema, body);
    if (validationError) return validationError as NextResponse;

    // Resolver-canonical: unsupported symbols, arbitrary addresses, and
    // symbol/address mismatches are rejected — never persisted.
    //
    // Production merchant product: USDC-only settlement. Any resolved
    // non-USDC preference (EURC symbol, EURC address, or both) is refused —
    // EURC can never be (re-)selected. A stored legacy EURC value is left
    // untouched (never blindly mutated).
    let canonicalAddress: string;
    try {
      canonicalAddress = resolvePreferenceUpdate({
        settlementToken: data.settlementToken,
        settlementTokenAddress: data.settlementTokenAddress,
      });
    } catch (prefErr: any) {
      return NextResponse.json({ success: false, error: prefErr.message }, { status: 400 });
    }
    let usdcAddress: string;
    try {
      usdcAddress = getTokenBySymbol('USDC').address;
    } catch {
      return NextResponse.json(
        { success: false, error: 'USDC settlement is unavailable on this network.' },
        { status: 500 }
      );
    }
    if (canonicalAddress.toLowerCase() !== usdcAddress.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'Merchant settlement is USDC-only.' },
        { status: 400 }
      );
    }

    const updated = await (prisma as any).merchant.update({
      where: { id: authed.id },
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
