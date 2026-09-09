// src/app/api/agent/checkout/route.ts
//
// DEPRECATED (security cleanup batch 1) — REMOVED, not preserved.
//
// This endpoint previously accepted payment parameters straight from the
// request body and spawned an unauthenticated background payment execution
// with NO authentication and NO ownership verification: any anonymous caller
// could drain agent wallets by supplying an arbitrary merchant address/amount.
// It is intentionally NOT preserved as a payment path — the canonical
// alternatives are:
//   - POST /api/agents/[id]/hire          (validated, provider-notified hiring)
//   - /api/payments/*                     (authenticated payment routes)
// POST returns 410 Gone; every other method is refused with 405 so the route
// exposes no reachable payment execution of any kind.

import { NextRequest, NextResponse } from 'next/server';

const GONE_BODY = {
  success: false as const,
  error: 'Gone',
  deprecated: true as const,
  message:
    'This unauthenticated agent checkout endpoint has been removed for security ' +
    '(audit P0). It no longer executes, queues, or schedules any payment. ' +
    'Use the canonical authenticated alternatives instead: POST /api/agents/[id]/hire ' +
    'to hire an agent, or the /api/payments/* routes for payments.',
  alternatives: ['/api/agents/[id]/hire', '/api/payments/*'],
};

// Kept as a tiny helper (no state, no imports of payment services) so the
// same response object is returned for every method.
function gone(): NextResponse {
  return NextResponse.json(GONE_BODY, {
    status: 410,
    headers: { Allow: 'GET, POST' },
  });
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  return gone();
}

export async function POST(_request: NextRequest): Promise<NextResponse> {
  return gone();
}
