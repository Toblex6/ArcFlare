import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrMerchant } from '@/lib/middleware/withMerchantAuth';

// SECURITY: this route was completely unauthenticated — gated with the
// existing withApiKeyOrMerchant wrapper as an immediate fix. Does not yet
// verify the caller owns the walletId supplied — that's the deeper
// identity-resolution fix still being designed (see handoff notes).
async function setBudgetJobHandler(req: NextRequest) {
  try {
    const { jobId, providerWalletId, budget } = await req.json();
    if (!jobId || !providerWalletId || !budget) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: providerWalletId });
    const providerAddress = wallet.data?.wallet?.address;
    if (!providerAddress) {
      return NextResponse.json({ error: 'Invalid provider wallet' }, { status: 400 });
    }

    const budgetAmount = BigInt(budget);
    const txHash = await createContractTransaction(
      providerAddress,
      AGENTIC_COMMERCE_CONTRACT,
      'setBudget(uint256,uint256,bytes)',
      [jobId, budgetAmount.toString(), '0x'],
      'set budget'
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { budget: budgetAmount, txHashes: { push: txHash } },
    });

    return NextResponse.json({ success: true, jobId, budget: budgetAmount.toString(), txHash });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export const POST = withApiKeyOrMerchant(setBudgetJobHandler);
