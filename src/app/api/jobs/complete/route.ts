import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { keccak256, toHex } from 'viem';

// SECURITY: fully closed now. Previously executed as any wallet named in
// evaluatorWalletId, without checking it against the job's actual evaluator
// or verifying the caller controls it.
async function completeJobHandler(req: NextRequest) {
  try {
    const { jobId, evaluatorWalletId, reason = 'deliverable-approved' } = await req.json();
    if (!jobId || !evaluatorWalletId) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: evaluatorWalletId });
    const evaluatorAddress = wallet.data?.wallet?.address;
    if (!evaluatorAddress) {
      return NextResponse.json({ error: 'Invalid evaluator wallet' }, { status: 400 });
    }

    if (evaluatorAddress.toLowerCase() !== job.evaluatorSCA.toLowerCase()) {
      return NextResponse.json({ error: 'evaluatorWalletId does not resolve to this job\'s evaluator.' }, { status: 403 });
    }

    const actor = await verifyCallerControlsAddress(req, evaluatorAddress);
    if (!actor) {
      return NextResponse.json({ error: 'You do not control this job\'s evaluator wallet.' }, { status: 403 });
    }

    const reasonHash = keccak256(toHex(reason));
    const txHash = await createContractTransaction(
      evaluatorAddress,
      AGENTIC_COMMERCE_CONTRACT,
      'complete(uint256,bytes32,bytes)',
      [jobId, reasonHash, '0x'],
      'complete job'
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: 'COMPLETED', reasonHash, txHashes: { push: txHash } },
    });

    return NextResponse.json({ success: true, jobId, status: 'COMPLETED', txHash });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export const POST = withApiKeyOrAnySession(completeJobHandler);
