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

import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { ARCFLARE_STREAM_CONTRACT_ADDRESS } from '@/lib/wallet/flarehqContracts';

const STREAM_CONTRACT =
  process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || ARCFLARE_STREAM_CONTRACT_ADDRESS || '';

const CONFLICT_MESSAGE = `The configured stream contract (${STREAM_CONTRACT || 'unset'}) is the criterion-based ArcFlareStream (nanopayments) contract, which has no withdraw(bytes32) function. The per-second streaming model this route implemented was replaced on 2026-08-21. Withdrawing from a per-second stream cannot be executed on-chain against this configuration, so FlareHQ refuses to record a fabricated withdrawal. Use the nanopayment stream flow (/api/jobs/nanopay/*) instead.`;

async function withdrawHandler(request: NextRequest) {
  const { reference, receiverSCA } = await request.json().catch(() => ({}));

  if (!reference || !receiverSCA) {
    return NextResponse.json(
      { success: false, error: 'reference and receiverSCA are required.' },
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

export const POST = withApiKey(withdrawHandler);
