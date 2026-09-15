// src/app/api/swap/execute/route.ts
// POST /api/swap/execute — server-executed Flow Swap for CIRCLE consumers.
//
// Flow: quote (POST /api/swap/quote) → execute (here) → verified result.
// The server broadcasts every step (approvals, wrap, swap, and the USDC
// unwrap exit when needed) from the consumer's own Circle developer-
// controlled SCA, then proves each step on-chain through the existing
// verification chain before reporting success. No browser wallet popup, no
// second authentication ceremony — the normal authenticated consumer_token
// session (+ step-up PIN where enrolled) is sufficient.
//
// EXTERNAL wallets are rejected here with a typed code pointing at the
// browser-signing flow (quote → sign → execute-intent → verify), which is
// unchanged. Legacy/unknown custody fails closed. The response never
// exposes routers, pools, calldata, or provider internals.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapServerExecuteSchema } from '@/src/lib/validation';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { verifyCallerControlsAddress } from '@/src/lib/wallet/verifyCallerControlsAddress';
import { requireConsumerStepUp } from '@/lib/auth/consumerStepUp';
import {
  getAuthenticatedConsumer,
  requireServerSigning,
  ConsumerFeatureError,
} from '@/src/lib/auth/consumerWallet';
import { executeFlowSwapAsServer } from '@/src/lib/swap/serverExecute';

// Long server round-trip (sequential on-chain broadcasts + verifications);
// a killed request is safe to retry (intents stay QUOTED until verified).
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapServerExecuteSchema, body);
    if (validationError) return validationError as NextResponse;

    // Authenticated consumer session first (401 when signed out).
    const sessionWallet = await resolveConsumerSession(req).catch(() => null);
    if (!sessionWallet) {
      return NextResponse.json(
        { success: false, error: 'Sign in required — Flow Swap needs an authenticated consumer wallet.' },
        { status: 401 }
      );
    }

    // Canonical wallet model: legacy/unknown custody fails closed here
    // (403), never as a guessed mode.
    const authed = await getAuthenticatedConsumer(req);
    if (!authed) {
      return NextResponse.json(
        {
          success: false,
          code: 'WALLET_UNSUPPORTED',
          error: 'This wallet type is no longer supported for swaps.',
        },
        { status: 403 }
      );
    }

    // Single feature signing rule: CIRCLE (+ bound signing identity)
    // proceeds; EXTERNAL gets the browser-flow code; unbound CIRCLE fails
    // closed with a recoverable state.
    let binding;
    try {
      binding = requireServerSigning(authed.wallet);
    } catch (e: any) {
      if (e instanceof ConsumerFeatureError) {
        const status = e.code === 'EXTERNAL_REQUIRES_BROWSER_SIGNATURE' ? 409 : e.status;
        return NextResponse.json(
          {
            success: false,
            code: e.code,
            error:
              e.code === 'EXTERNAL_REQUIRES_BROWSER_SIGNATURE'
                ? 'This wallet signs in the browser — quote then sign each step yourself (POST /api/swap/quote, then /api/swap/execute-intent, then /api/swap/verify). The server cannot sign for it.'
                : e.message,
          },
          { status }
        );
      }
      throw e;
    }

    // Ownership proof: the session must control the wallet being debited.
    const actor = await verifyCallerControlsAddress(req, sessionWallet);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'Wallet ownership could not be verified for this session — refusing to execute.' },
        { status: 403 }
      );
    }

    // Consumer step-up (Stage 2): server-side execution moves funds off the
    // consumer's own wallet — a session alone is not sufficient once a
    // payment PIN is enrolled.
    const stepUp = await requireConsumerStepUp(req, authed.account, 'consumer.swap');
    if (stepUp) return stepUp;

    const result = await executeFlowSwapAsServer({
      ownerWallet: sessionWallet,
      circleWalletId: binding.circleWalletId,
      ...(data.intentId ? { intentId: data.intentId } : {}),
      ...(data.quoteHash ? { quoteHash: data.quoteHash } : {}),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap execute error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Swap execution failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap server execution is active (CIRCLE wallets; UnitFlow execution).',
  });
}
