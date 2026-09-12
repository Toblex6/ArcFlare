// src/app/api/swap/execute-intent/route.ts
// POST /api/swap/execute-intent — register broadcast hashes for a live Flow
// Swap intent (backend only; no UI in this stage).
//
// The user's wallet broadcasts the unsigned transactions from POST
// /api/swap/quote (WUSDC.deposit wrap first for USDC-leg inputs, then the
// router execute()) and reports the hashes here. The service checks intent
// ownership, liveness, and cross-table single-consumption, then persists
// the hashes — status stays QUOTED until POST /api/swap/verify proves the
// execution on-chain. Nothing here moves funds or trusts client claims.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapExecuteIntentSchema } from '@/src/lib/validation';
import { registerFlowSwapExecution, resolveFlowPayer } from '@/src/lib/swap/service';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapExecuteIntentSchema, body);
    if (validationError) return validationError as NextResponse;

    const { wallet } = await resolveFlowPayer(req);

    const intent = await registerFlowSwapExecution({
      ownerWallet: wallet,
      ...(data.intentId ? { intentId: data.intentId } : {}),
      ...(data.quoteHash ? { quoteHash: data.quoteHash } : {}),
      ...(data.wrapTxHash ? { wrapTxHash: data.wrapTxHash } : {}),
      executionTxHash: data.executionTxHash,
    });
    return NextResponse.json({
      success: true,
      intentId: intent.id,
      quoteHash: intent.quoteHash,
      status: intent.status,
      wrapTxHash: intent.wrapTxHash,
      executionTxHash: intent.executionTxHash,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap execute-intent error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Execute-intent failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap execute-intent tracking is active.',
  });
}
