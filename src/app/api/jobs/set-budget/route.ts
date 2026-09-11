import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { getNetworkConfig } from '@/lib/config/network';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { requireConsumerStepUpForActor } from '@/lib/auth/consumerStepUp';

// ERC-8183 contract address resolves from the authoritative network config
// (mainnet-aware) — never the static testnet pin in erc8183.ts.
const ERC8183_ADDRESS = getNetworkConfig().erc8183Address as `0x${string}`;

// SECURITY: fully closed now. Previously executed as any wallet named in
// providerWalletId, without checking it against the job's actual provider
// or verifying the caller controls it.
async function setBudgetJobHandler(req: NextRequest) {
  try {
    const { jobId, providerWalletId, budget } = await req.json();
    if (!jobId || !providerWalletId || !budget) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // Malformed jobIds are a caller error (400), not a server error — the
    // same invalid-jobId contract as the canonical [jobId]/accept route.
    // (Previously BigInt(jobId) threw inside the outer try → 500.)
    try {
      BigInt(jobId);
    } catch {
      return NextResponse.json({ error: `invalid job id ${jobId}` }, { status: 400 });
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

    // Consumer step-up (Stage 2) for consumer providers.
    const stepUp = await requireConsumerStepUpForActor(req, actor, 'consumer.job-fund');
    if (stepUp) return stepUp;

    const budgetAmount = BigInt(budget);
    const txHash = await createContractTransaction(
      providerAddress,
      ERC8183_ADDRESS,
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
export const POST = withApiKeyOrAnySession(setBudgetJobHandler);
