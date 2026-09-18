// src/app/api/swap/quote/route.ts
// POST /api/swap/quote — Flow Swap quote (backend only; no UI in this stage).
//
// Authenticated consumer session required. The client supplies symbols +
// a decimal amount only; the shared swap service resolves the payer from
// the session (verifyCallerControlsAddress gate), builds the live-validated
// UnitFlow execution, persists the intent, and returns unsigned transactions
// for the user's wallet to sign. The server never signs user funds.
// Tower may be consulted for informational comparison — it never executes.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapQuoteSchema } from '@/src/lib/validation';
import { getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import {
  assertSwapSymbol,
  parseCanonicalAmount,
  requestFlowSwapQuote,
  resolveFlowPayer,
} from '@/src/lib/swap/service';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapQuoteSchema, body);
    if (validationError) return validationError as NextResponse;

    // Explicit authenticated payer — no default, no fallback, no body wallet.
    const { wallet } = await resolveFlowPayer(req);

    const inputSymbol = assertSwapSymbol(data.inputSymbol);
    const outputSymbol = assertSwapSymbol(data.outputSymbol);
    // Token-native precision: 6 for USDC/EURC, 8 for cirBTC (never a global 6).
    const inputAmount = parseCanonicalAmount(data.amount, getTokenBySymbol(inputSymbol).decimals);

    const { view, tower } = await requestFlowSwapQuote({
      ownerWallet: wallet,
      inputSymbol,
      outputSymbol,
      inputAmount,
    });
    // Temporary diagnostic (per-request, no secrets): mirrors the Tower
    // outcome into Render logs so a prod quote can be correlated with the
    // [tower-diag] lines emitted inside getTowerCandidate()/towerFetchJson.
    console.log(
      `[swap-quote] tower consulted=${tower.consulted} available=${tower.available} ` +
        `note=${String(tower.note ?? '').slice(0, 160)} intent=${view.intentId} pair=${inputSymbol}->${outputSymbol}`
    );
    return NextResponse.json({ success: true, ...view, tower });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap quote error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Swap quote failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap quoting is active (Arc USDC↔EURC↔cirBTC, UnitFlow execution).',
  });
}
