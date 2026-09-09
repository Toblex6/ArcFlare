// src/app/api/agent-data/route.ts
//
// DEPRECATED (security cleanup batch 1) — REMOVED, not preserved.
//
// This endpoint previously minted ledger rows with status 'VERIFIED' from
// unverified, caller-supplied x-payment-* headers — no on-chain lookup, no
// signature check, no settlement confirmation. It could not prove any payment
// had occurred and created forged-verification entries. It is NOT a
// real payment path: use the authenticated payment APIs instead
// (POST /api/payments/initialize → POST /api/payments/settle, or the
// ERC-8183 job escrow flow).
//
// GET/POST now return 410 Gone. No payment-ledger row is ever created and no
// fake x402 verification runs. Method stubs below are exported only so
// unsupported methods answer 410 explicitly instead of falling through to
// route-level 405s with misleading Allow semantics.

import { NextRequest, NextResponse } from 'next/server';

const GONE_BODY = {
  success: false as const,
  error: 'Gone',
  deprecated: true as const,
  message:
    'This endpoint was removed for security (audit P0): it recorded VERIFIED ' +
    'payment-ledger entries from unverified request headers. It can no longer create ' +
    'any database record or verify any payment. Use the authenticated payment APIs ' +
    'instead: POST /api/payments/initialize then POST /api/payments/settle, or the ' +
    'ERC-8183 job escrow flow for agent work.',
  alternatives: [
    'POST /api/payments/initialize + POST /api/payments/settle',
    '/api/jobs (ERC-8183 escrow)',
  ],
};

function gone(): NextResponse {
  return NextResponse.json(GONE_BODY, { status: 410 });
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  return gone();
}

export async function POST(_request: NextRequest): Promise<NextResponse> {
  return gone();
}
