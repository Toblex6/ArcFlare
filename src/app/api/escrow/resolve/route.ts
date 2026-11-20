// src/app/api/escrow/resolve/route.ts
//
// Arbiter-only dispute resolution. The contract is the authority: it accepts
// resolveDispute only from `arbiter`. This route adds authentication (the
// caller must actually control the wallet it names) and mirrors the resulting
// on-chain state; it cannot widen who may resolve.
//
// Internal-api-key gated because it is an operator/Safe action, not a party
// action. A Circle-controlled arbiter wallet signs directly; an external
// arbiter wallet is queued as a transaction request.

import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { createCircleClient as initiateDeveloperControlledWalletsClient } from '@/lib/circle/client';
import { getNetworkConfig } from '@/lib/config/network';
import { escrowAddressOr503 } from '@/lib/escrow/escrowGuard';

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(client: ReturnType<typeof getCircleClient>, txId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    if (state === 'COMPLETE' && data?.transaction?.txHash) return data.transaction.txHash;
    if (state === 'FAILED') {
      throw new Error(`Resolve transaction failed onchain.${data?.transaction?.errorReason ? ` Reason: ${data.transaction.errorReason}` : ''}`);
    }
  }
  throw new Error('Resolve transaction timed out.');
}

async function resolveHandler(request: NextRequest) {
  const escrowGuard = escrowAddressOr503();
  if ('response' in escrowGuard) return escrowGuard.response;
  const ESCROW_CONTRACT = escrowGuard.address;

  const { reference, callerSCA, releaseToBeneficiary } = await request.json().catch(() => ({}));
  if (!reference || !callerSCA || typeof releaseToBeneficiary !== 'boolean') {
    return NextResponse.json({ success: false, error: 'reference, callerSCA and releaseToBeneficiary are required.' }, { status: 400 });
  }

  const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
  if (!escrow) return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
  if (escrow.status !== 'DISPUTED') {
    return NextResponse.json({ success: false, error: `Escrow is ${escrow.status} — only a disputed escrow can be resolved.` }, { status: 400 });
  }
  if (!escrow.contractEscrowId) {
    return NextResponse.json({ success: false, error: 'This escrow has no on-chain id.' }, { status: 400 });
  }

  const actor = await verifyCallerControlsAddress(request, callerSCA);
  if (!actor) {
    return NextResponse.json({ success: false, error: 'You do not control the wallet named in callerSCA.' }, { status: 403 });
  }

  const client = getCircleClient();
  const tx = await client.createContractExecutionTransaction({
    walletAddress: callerSCA,
    blockchain: getNetworkConfig().circleBlockchain as any,
    contractAddress: ESCROW_CONTRACT,
    abiFunctionSignature: 'resolveDispute(bytes32,bool)',
    abiParameters: [escrow.contractEscrowId, releaseToBeneficiary],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  if (!tx.data?.id) throw new Error('Resolve tx returned no ID.');
  const txHash = await waitForCircleTx(client, tx.data.id);

  const updated = await (prisma as any).escrow.update({
    where: { reference },
    data: {
      status: releaseToBeneficiary ? 'RELEASED' : 'REFUNDED',
      releaseTxHash: txHash,
    },
  });
  return NextResponse.json({ success: true, escrow: updated, txHash });
}

export const POST = withApiKey(resolveHandler);
