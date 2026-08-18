import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT, USDC_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';

// SECURITY: fully closed now. Previously resolved clientWalletId to any
// address in our Circle entity and executed as it, without checking it
// matched the job's actual client or that the caller controlled it.
async function fundJobHandler(req: NextRequest) {
  try {
    const { jobId, clientWalletId } = await req.json();
    if (!jobId || !clientWalletId) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: clientWalletId });
    const clientAddress = wallet.data?.wallet?.address;
    if (!clientAddress) {
      return NextResponse.json({ error: 'Invalid client wallet' }, { status: 400 });
    }

    // Membership: this wallet must actually be the job's client.
    if (clientAddress.toLowerCase() !== job.clientSCA.toLowerCase()) {
      return NextResponse.json({ error: 'clientWalletId does not resolve to this job\'s client.' }, { status: 403 });
    }

    // Ownership: the caller must actually control that address.
    const actor = await verifyCallerControlsAddress(req, clientAddress);
    if (!actor) {
      return NextResponse.json({ error: 'You do not control this job\'s client wallet.' }, { status: 403 });
    }

    // Approve USDC
    const approveTx = await createContractTransaction(
      clientAddress,
      USDC_CONTRACT,
      'approve(address,uint256)',
      [AGENTIC_COMMERCE_CONTRACT, job.budget.toString()],
      'approve USDC'
    );

    // Fund escrow
    const fundTx = await createContractTransaction(
      clientAddress,
      AGENTIC_COMMERCE_CONTRACT,
      'fund(uint256,bytes)',
      [jobId, '0x'],
      'fund escrow'
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: 'FUNDED', txHashes: { push: [approveTx, fundTx] } },
    });

    return NextResponse.json({ success: true, jobId, status: 'FUNDED', approveTx, fundTx });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export const POST = withApiKeyOrAnySession(fundJobHandler);
