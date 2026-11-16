// src/app/api/payments/stream/stop/route.ts
//
// EXTERNAL-WALLET / STREAM-STOP STATUS: UNSUPPORTED — FAIL CLOSED.
//
// The configured stream contract (ARCFLARE_STREAM_CONTRACT_ADDRESS =
// 0xd8ca3Bbc…A52B) is the deployed criterion-based ArcFlareStream.sol
// (openStream/releaseTranche/closeStream, uint256 streamId — nanopayments,
// deployed 2026-08-21). It does NOT implement `stopStream(bytes32)` /
// `withdraw(bytes32)` / `createStream(...)`, which is the per-second
// streaming interface this route previously claimed.
//
// Verified 2026-08-31 against the deployed bytecode: those selectors are
// absent (eth_call reverts with "missing revert data"). Broadcasting a
// `stopStream` call to the configured address would revert on-chain, and
// fabricating a server-side "STOPPED" without a real transaction would be
// the exact fake-success this codebase no longer permits.
//
// The per-second streaming model was replaced by the nanopayment stream
// (see /api/jobs/nanopay/* and src/lib/contracts/streamContract.ts). This
// route therefore refuses to fabricate anything and reports the conflict.
//
// Per the external-wallet repair spec (§9/§10): "real or explicitly rejected
// if unsupported." This is an explicit rejection.

import { NextResponse } from 'next/server';
import { streamAddressOr503 } from '@/lib/stream/streamGuard';

async function stopStreamHandler() {
  // No body parsing or stream lookup: this operation cannot be executed.
  const streamGate = streamAddressOr503();
  if ('response' in streamGate) return streamGate.response;

  return NextResponse.json(
    {
      success: false,
      error: 'streaming stop is not available',
      code: 'STREAM_ABI_CONFIG_CONFLICT',
      message: 'The deployed stream contract has no stop/refund operation. closeStream(uint256) pays all remaining funds to the worker; it cannot safely substitute for a per-second stop. Use /api/jobs/nanopay/* for job tranches. No funds have moved.',
    },
    { status: 503 }
  );
}

export const POST = stopStreamHandler;
