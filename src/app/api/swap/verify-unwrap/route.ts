// src/app/api/swap/verify-unwrap/route.ts
// POST /api/swap/verify-unwrap — prove the WUSDC.withdraw unwrap on-chain.
//
// Evidence-based: the unwrap tx must target the canonical WUSDC contract
// from the session wallet, decode to withdraw() of exactly the verified
// swap proceeds, be mined successfully after the swap, and show a covering
// native-USDC balance delta at fixed block tags. Stateless — no writes.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapUnwrapVerifySchema } from '@/src/lib/validation';
import { resolveFlowPayer, verifyFlowUnwrap } from '@/src/lib/swap/service';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapUnwrapVerifySchema, body);
    if (validationError) return validationError as NextResponse;

    const { wallet } = await resolveFlowPayer(req);

    const result = await verifyFlowUnwrap({
      ownerWallet: wallet,
      ...(data.intentId ? { intentId: data.intentId } : {}),
      ...(data.quoteHash ? { quoteHash: data.quoteHash } : {}),
      unwrapTxHash: data.unwrapTxHash,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap verify-unwrap error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Unwrap verification failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap unwrap verification is active.',
  });
}
