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

import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { ARCFLARE_STREAM_CONTRACT_ADDRESS } from '@/lib/wallet/flarehqContracts';

const STREAM_CONTRACT =
  process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || ARCFLARE_STREAM_CONTRACT_ADDRESS || '';

const CONFLICT_MESSAGE = `The configured stream contract (${STREAM_CONTRACT || 'unset'}) is the criterion-based ArcFlareStream (nanopayments) contract, which has no stopStream(bytes32) function. The per-second streaming model this route implemented was replaced on 2026-08-21. Stopping a per-second stream cannot be executed on-chain against this configuration, so FlareHQ refuses to record a fabricated stop. Use the nanopayment stream flow (/api/jobs/nanopay/*) instead.`;

async function stopStreamHandler(request: NextRequest) {
  const { reference, callerSCA } = await request.json().catch(() => ({}));

  if (!reference || !callerSCA) {
    return NextResponse.json(
      { success: false, error: 'reference and callerSCA are required.' },
      { status: 400 }
    );
  }

  const stream = await prisma.stream.findUnique({ where: { reference } });
  if (!stream) {
    return NextResponse.json({ success: false, error: 'Stream not found.' }, { status: 404 });
  }

  return NextResponse.json(
    {
      success: false,
      error: CONFLICT_MESSAGE,
      code: 'STREAM_ABI_CONFIG_CONFLICT',
    },
    { status: 501 }
  );
}

export const POST = withApiKey(stopStreamHandler);
