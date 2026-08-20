// src/lib/middleware/withMerchantAuth.ts
// Single source of truth for "which merchant is making this call."
// Accepts EITHER:
//   - the merchant_token cookie (browser dashboard sessions), OR
//   - an x-api-key header matching a Merchant's own apiKey (developer/API calls)
// Both paths resolve to the same thing: a merchantId attached to the request,
// so every downstream route can scope data without caring which auth method
// was used.
//
// Secrets fail closed: if MERCHANT_JWT_SECRET / CONSUMER_JWT_SECRET are not
// configured, no session resolves and no token is accepted. There are no
// hardcoded fallbacks.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { jwtVerify } from 'jose';
import { tryJwtSecret } from '@/lib/auth/secrets';

const JWT_SECRET = tryJwtSecret('MERCHANT_JWT_SECRET');
const CONSUMER_JWT_SECRET = tryJwtSecret('CONSUMER_JWT_SECRET');

export interface AuthedMerchant {
  id: string;
  email: string;
  businessName: string;
}

// M18 — a cookie token is only valid for the account's CURRENT session
// version. Tokens without the claim (issued before 0008_merchant_session_version)
// and tokens issued before the latest password reset are rejected, so a
// stolen cookie dies the moment the password changes.
function sessionVersionMatches(payload: unknown, merchant: { sessionVersion?: number | null }): boolean {
  const expected = merchant.sessionVersion ?? 0;
  return (payload as any)?.sessionVersion === expected;
}

export async function resolveMerchant(req: NextRequest): Promise<AuthedMerchant | null> {
  // ── Path A: API key (developer calls, curl, server-to-server) ──────────
  const apiKey = req.headers.get('x-api-key');
  if (apiKey) {
    const merchant = await (prisma as any).merchant.findUnique({ where: { apiKey } });
    if (merchant && merchant.active && merchant.verified) {
      return { id: merchant.id, email: merchant.email, businessName: merchant.businessName };
    }
    return null; // an api key was supplied but didn't match — fail closed, don't fall through
  }

  // ── Path B: dashboard cookie session ────────────────────────────────────
  const token = req.cookies.get('merchant_token')?.value;
  if (token && JWT_SECRET) {
    try {
      const { payload } = await jwtVerify(token, JWT_SECRET);
      const merchant = await (prisma as any).merchant.findUnique({
        where: { id: payload.merchantId as string },
      });
      // Cookie tokens are only issued to verified+active merchants (see
      // merchant/login), but re-check both here so deactivation or a
      // verification-state change takes effect before the token expires.
      // M18: a stale session version (pre-reset token) is rejected too.
      if (merchant && merchant.active && merchant.verified && sessionVersionMatches(payload, merchant)) {
        return { id: merchant.id, email: merchant.email, businessName: merchant.businessName };
      }
    } catch {
      // invalid/expired token — fall through to null
    }
  }

  return null;
}

export interface ResolvedCaller {
  type: 'merchant' | 'consumer' | 'internal';
  merchant?: AuthedMerchant;
  consumerWalletAddress?: string;
}

// For routes used by THREE different callers: merchants (creating payment
// links via API), consumers (Flow send/request, no merchant key at all),
// and internal server-to-server calls (agent-to-agent x402 payments via
// agent/brain). Each is validated against its own real credential — no
// shared secret, no unauthenticated fallback.
export async function resolveInitializeCaller(req: NextRequest): Promise<ResolvedCaller | null> {
  const apiKey = req.headers.get('x-api-key');

  if (apiKey) {
    // Internal/service key — used only by our own server-to-server calls
    // (e.g. agent/brain), validated against the real ApiKey table, same
    // as withApiKey does elsewhere. Never exposed to a browser.
    const serviceKey = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
    if (serviceKey && serviceKey.active) {
      return { type: 'internal' };
    }

    // Merchant key — a real merchant creating a payment link via API
    const merchant = await (prisma as any).merchant.findUnique({ where: { apiKey } });
    if (merchant && merchant.active && merchant.verified) {
      return {
        type: 'merchant',
        merchant: { id: merchant.id, email: merchant.email, businessName: merchant.businessName },
      };
    }

    return null; // a key was supplied but matched nothing — fail closed
  }

  // Consumer session — Flow's send/request flow, no API key involved
  const consumerToken = req.cookies.get('consumer_token')?.value;
  if (consumerToken && CONSUMER_JWT_SECRET) {
    try {
      const { payload } = await jwtVerify(consumerToken, CONSUMER_JWT_SECRET);
      return { type: 'consumer', consumerWalletAddress: payload.walletAddress as string };
    } catch {
      return null;
    }
  }

  return null;
}

// For existing routes that already use withApiKey (validated against the
// real ApiKey table) and whose business logic we don't want to touch.
// This is purely additive: it keeps the original internal-key check
// working exactly as before, and ALSO accepts a merchant's own API key
// or their dashboard cookie — so merchants (and the browser dashboard)
// can actually call these routes, which they couldn't before. It does
// NOT change what happens once authenticated, and does not inject a
// merchant object into the handler — same call signature as withApiKey.
export function withApiKeyOrMerchant(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const apiKey = req.headers.get('x-api-key');

    if (apiKey) {
      const serviceKey = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
      if (serviceKey && serviceKey.active) {
        return handler(req);
      }
      const merchant = await (prisma as any).merchant.findUnique({ where: { apiKey } });
      if (merchant && merchant.active && merchant.verified) {
        return handler(req);
      }
      return NextResponse.json({ success: false, error: 'Invalid API key.' }, { status: 401 });
    }

    const token = req.cookies.get('merchant_token')?.value;
    if (token && JWT_SECRET) {
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET);
        const merchant = await (prisma as any).merchant.findUnique({
          where: { id: payload.merchantId as string },
        });
        if (merchant && merchant.active && merchant.verified && sessionVersionMatches(payload, merchant)) {
          return handler(req);
        }
      } catch {
        // fall through to 401 below
      }
    }

    return NextResponse.json(
      { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
      { status: 401 }
    );
  };
}

// Same additive pattern as withApiKeyOrMerchant, but also accepts a
// consumer session cookie. Needed for routes used by Flow (consumer
// send/save/request) as well as merchants and internal service calls —
// e.g. payments/settle. Doesn't change existing behavior, only adds
// a third legitimate way in.
export function withApiKeyOrAnySession(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const apiKey = req.headers.get('x-api-key');

    if (apiKey) {
      const serviceKey = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
      if (serviceKey && serviceKey.active) return handler(req);

      const merchant = await (prisma as any).merchant.findUnique({ where: { apiKey } });
      if (merchant && merchant.active && merchant.verified) return handler(req);

      return NextResponse.json({ success: false, error: 'Invalid API key.' }, { status: 401 });
    }

    const merchantToken = req.cookies.get('merchant_token')?.value;
    if (merchantToken && JWT_SECRET) {
      try {
        const { payload } = await jwtVerify(merchantToken, JWT_SECRET);
        const merchant = await (prisma as any).merchant.findUnique({
          where: { id: payload.merchantId as string },
        });
        if (merchant && merchant.active && merchant.verified && sessionVersionMatches(payload, merchant)) {
          return handler(req);
        }
      } catch {
        // fall through
      }
    }

    const consumerToken = req.cookies.get('consumer_token')?.value;
    if (consumerToken && CONSUMER_JWT_SECRET) {
      try {
        await jwtVerify(consumerToken, CONSUMER_JWT_SECRET);
        return handler(req);
      } catch {
        // fall through
      }
    }

    return NextResponse.json(
      { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
      { status: 401 }
    );
  };
}

// The resolved merchant is passed as the second argument to the handler.
export function withMerchantAuth(
  handler: (req: NextRequest, merchant: AuthedMerchant) => Promise<NextResponse>
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const merchant = await resolveMerchant(req);
    if (!merchant) {
      return NextResponse.json(
        { success: false, error: 'Authentication required. Provide a valid x-api-key or log in.' },
        { status: 401 }
      );
    }
    return handler(req, merchant);
  };
}