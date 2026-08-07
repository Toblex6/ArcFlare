import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrMerchant } from '@/lib/middleware/withMerchantAuth';
import { keccak256, toHex } from 'viem';

// SECURITY: this route was completely unauthenticated — gated with the
// existing withApiKeyOrMerchant wrapper as an immediate fix. Does not yet
// verify the caller owns the walletId supplied — that's the deeper
// identity-resolution fix still being designed (see handoff notes).
async function submitJobHandler(req: NextRequest) {
  try {
    const { jobId, providerWalletId, deliverableData } = await req.json();
    if (!jobId || !providerWalletId || !deliverableData) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: providerWalletId });
    const providerAddress = wallet.data?.wallet?.address;
    if (!providerAddress) {
      return NextResponse.json({ error: 'Invalid provider wallet' }, { status: 400 });
    }

    const deliverableHash = keccak256(toHex(deliverableData));
    const txHash = await createContractTransaction(
      providerAddress,
      AGENTIC_COMMERCE_CONTRACT,
      'submit(uint256,bytes32,bytes)',
      [jobId, deliverableHash, '0x'],
      'submit deliverable'
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: 'SUBMITTED', deliverableHash, txHashes: { push: txHash } },
    });

    return NextResponse.json({
      success: true,
      jobId,
      status: 'SUBMITTED',
      deliverableHash,
      txHash,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export const POST = withApiKeyOrMerchant(submitJobHandler);
