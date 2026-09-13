// src/app/api/swap/unwrap/route.ts
// POST /api/swap/unwrap — build the unsigned WUSDC.withdraw unwrap step for
// a VERIFIED (EXECUTED) EURC→USDC Flow Swap.
//
// The UnitFlow V3 pools settle the USDC leg in WUSDC, so the swap credits
// WUSDC first. This route returns the single unsigned withdraw transaction
// that burns exactly the verified proceeds into native USDC in the user's
// own wallet. Amount and recipient are server-resolved from the EXECUTED
// intent — never client-supplied. The server never signs.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapUnwrapSchema } from '@/src/lib/validation';
import { requestFlowUnwrap, resolveFlowPayer } from '@/src/lib/swap/service';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapUnwrapSchema, body);
    if (validationError) return validationError as NextResponse;

    const { wallet } = await resolveFlowPayer(req);

    const result = await requestFlowUnwrap({
      ownerWallet: wallet,
      ...(data.intentId ? { intentId: data.intentId } : {}),
      ...(data.quoteHash ? { quoteHash: data.quoteHash } : {}),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap unwrap error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Swap unwrap failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap unwrap is active (WUSDC→native USDC exit).',
  });
}
