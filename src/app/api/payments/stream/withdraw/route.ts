// src/app/api/payments/stream/withdraw/route.ts
//
// EXTERNAL-WALLET / STREAM-WITHDRAW STATUS: UNSUPPORTED — FAIL CLOSED.
//
// Same conflict as payments/stream/stop: the configured stream contract
// (ARCFLARE_STREAM_CONTRACT_ADDRESS = 0xd8ca3Bbc…A52B) is the deployed
// criterion-based ArcFlareStream.sol (openStream/releaseTranche/closeStream,
// uint256 streamId — nanopayments, deployed 2026-08-21). It does NOT
// implement `withdraw(bytes32)` / `stopStream(bytes32)` / `createStream(...)`.
//
// Verified 2026-08-31 against the deployed bytecode: the `withdraw(bytes32)`
// selector is absent (eth_call reverts with "missing revert data"). A real
// withdraw broadcast to the configured address would revert on-chain, and a
// fabricated server-side withdrawal would be a fake-success. This route
// refuses to fabricate.
//
// Per the external-wallet repair spec (§9/§10): "real or explicitly rejected
// if unsupported." This is an explicit rejection.

import { NextResponse } from 'next/server';
import { streamAddressOr503 } from '@/lib/stream/streamGuard';

async function withdrawHandler() {
  // No body parsing or stream lookup: this operation cannot be executed.
  const streamGate = streamAddressOr503();
  if ('response' in streamGate) return streamGate.response;

  return NextResponse.json(
    {
      success: false,
      error: 'streaming withdraw is not available',
      code: 'STREAM_ABI_CONFIG_CONFLICT',
      message: 'The deployed stream contract has no receiver withdrawal operation. Only the poster can release job tranches or close the stream. Use /api/jobs/nanopay/* for job tranches. No funds have moved.',
    },
    { status: 503 }
  );
}

export const POST = withdrawHandler;
