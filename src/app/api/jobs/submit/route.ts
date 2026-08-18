import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { keccak256, toHex } from 'viem';

// SECURITY: fully closed now. Previously executed as any wallet named in
// providerWalletId, without checking it against the job's actual provider
// or verifying the caller controls it.
async function submitJobHandler(req: NextRequest) {
  try {
    const { jobId, providerWalletId, deliverableData } = await req.json();
    if (!jobId || !providerWalletId || !deliverableData) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: providerWalletId });
    const providerAddress = wallet.data?.wallet?.address;
    if (!providerAddress) {
      return NextResponse.json({ error: 'Invalid provider wallet' }, { status: 400 });
    }

    if (providerAddress.toLowerCase() !== job.providerSCA.toLowerCase()) {
      return NextResponse.json({ error: 'providerWalletId does not resolve to this job\'s provider.' }, { status: 403 });
    }

    const actor = await verifyCallerControlsAddress(req, providerAddress);
    if (!actor) {
      return NextResponse.json({ error: 'You do not control this job\'s provider wallet.' }, { status: 403 });
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
export const POST = withApiKeyOrAnySession(submitJobHandler);
