// src/app/api/swap/verify/route.ts
// POST /api/swap/verify — verify a Flow Swap execution on-chain (backend
// only; no UI in this stage).
//
// Collects fixed-block-tag evidence for the broadcast swap (plus the wrap
// linkage for USDC-leg inputs), runs the existing pure UnitFlow verifier,
// enforces payer == session wallet and cross-table single-consumption, and
// atomically marks the intent EXECUTED. Replay of the same execution
// re-verifies idempotently; any other tx against a consumed intent is a 409.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapVerifySchema } from '@/src/lib/validation';
import { resolveFlowPayer, verifyFlowSwap } from '@/src/lib/swap/service';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapVerifySchema, body);
    if (validationError) return validationError as NextResponse;

    const { wallet } = await resolveFlowPayer(req);

    const result = await verifyFlowSwap({
      ownerWallet: wallet,
      ...(data.intentId ? { intentId: data.intentId } : {}),
      ...(data.quoteHash ? { quoteHash: data.quoteHash } : {}),
      ...(data.wrapTxHash ? { wrapTxHash: data.wrapTxHash } : {}),
      ...(data.executionTxHash ? { executionTxHash: data.executionTxHash } : {}),
    });
    return NextResponse.json({
      success: true,
      alreadySettled: result.alreadySettled,
      intentId: result.intent.id,
      status: result.intent.status,
      payer: result.payer,
      actualInput: result.actualInput,
      actualOutput: result.actualOutput,
      executionTxHash: result.intent.executionTxHash,
      wrapTxHash: result.intent.wrapTxHash,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap verify error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Swap verification failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap verification is active.',
  });
}
