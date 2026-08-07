import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT, USDC_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrMerchant } from '@/lib/middleware/withMerchantAuth';

// SECURITY: this route was completely unauthenticated — anyone who could
// guess a jobId + Circle walletId could trigger a real USDC approve+fund
// transaction. Gated with the existing withApiKeyOrMerchant wrapper as an
// immediate fix. This does NOT yet verify the caller actually owns
// clientWalletId — that's the deeper identity-resolution fix still being
// designed (see handoff notes). This patch closes the "fully open to the
// internet" hole; the "which merchant does this walletId really belong to"
// hole is still open pending that design.
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
export const POST = withApiKeyOrMerchant(fundJobHandler);
