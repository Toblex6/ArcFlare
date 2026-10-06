import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { prisma } from '@/lib/prisma';
import { getNetworkConfig } from '@/lib/config/network';
import { erc8183AddressOr503 } from '@/lib/jobs/erc8183Guard';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { requireConsumerStepUpForActor } from '@/lib/auth/consumerStepUp';

// ERC-8183 contract + USDC token address resolve from the authoritative
// network config (mainnet-aware) — never static testnet pins in erc8183.ts.
// ERC-8183 resolves per-request via erc8183AddressOr503() (fail-closed 503
// when the external protocol address is unconfigured), never at module level.
const USDC_ADDRESS = getNetworkConfig().usdcAddress as `0x${string}`;

// SECURITY: fully closed now. Previously resolved clientWalletId to any
// address in our Circle entity and executed as it, without checking it
// matched the job's actual client or that the caller controlled it.
//
// SPEND-POLICY CONVERGENCE (final-fix pass): when the job's client is a
// registered agent, this route DELEGATES to the canonical
// POST /api/jobs/[jobId]/fund handler — rate-limit, treasury policy,
// spend-limit (pre-flight + on-chain record), server-resolved wallet,
// idempotency, and job-state validation all enforced there. The legacy
// approve+fund body below runs ONLY for non-agent (merchant/consumer
// owner-wallet) clients, which have no treasury/spend-limit to bypass and
// which the canonical route would 404 ("client agent not found").
// Caller-supplied clientWalletId is ignored on the delegated path — the
// canonical handler resolves the payer server-side from AgentRegistry.
async function fundJobHandler(req: NextRequest) {
  try {
    const erc8183 = erc8183AddressOr503();
    if ("response" in erc8183) return erc8183.response;
    const ERC8183_ADDRESS = erc8183.address;
    const { jobId, clientWalletId } = await req.json();
    if (!jobId || !clientWalletId) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // Malformed jobIds are a caller error (400), not a server error — the
    // same invalid-jobId contract as the canonical [jobId]/fund route.
    // (Previously BigInt(jobId) threw inside the outer try → 500.)
    try {
      BigInt(jobId);
    } catch {
      return NextResponse.json({ error: `invalid job id ${jobId}` }, { status: 400 });
    }

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    // Agent-client convergence: the spend-policy gap lived here — an agent
    // client funding through this flat route bypassed treasury policy and
    // spend-limit enforcement entirely. Route agent clients into the
    // canonical handler so the same invariants hold on both paths.
    // (The canonical handler reads jobId from ctx.params only — never the
    // body — and re-runs the same auth wrapper, so delegating the already-
    // authenticated request is safe.)
    const clientAgent = await (prisma as any).agentRegistry.findFirst({
      where: { scaAddress: { equals: job.clientSCA, mode: "insensitive" } },
      select: { id: true },
    }).catch(() => null);
    if (clientAgent) {
      const { POST: canonicalFundPOST } = await import("@/app/api/jobs/[jobId]/fund/route");
      return canonicalFundPOST(req as any, { params: Promise.resolve({ jobId: String(jobId) }) });
    }

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

    // Consumer step-up (Stage 2): a consumer session alone is not sufficient
    // to fund escrow once a payment PIN is enrolled.
    const stepUp = await requireConsumerStepUpForActor(req, actor, 'consumer.job-fund');
    if (stepUp) return stepUp;

    // Approve USDC
    const approveTx = await createContractTransaction(
      clientAddress,
      USDC_ADDRESS,
      'approve(address,uint256)',
      [ERC8183_ADDRESS, job.budget.toString()],
      'approve USDC'
    );

    // Fund escrow
    const fundTx = await createContractTransaction(
      clientAddress,
      ERC8183_ADDRESS,
      'fund(uint256,bytes)',
      [jobId, '0x'],
      'fund escrow'
    );

    await prisma.erc8183Job.update({
      where: { jobId: BigInt(jobId) },
      data: { status: 'FUNDED', txHashes: { push: [approveTx, fundTx] } },
    });

    // Build 3 ledger: escrow lock for client if client is an agent — awaited before response
    try {
      const { recordLedgerEntry, resolveAgentIdBySca, usdcLedgerIdentity } = await import("@/lib/ledger/ledgerService");
      const clientAgentId = await resolveAgentIdBySca(job.clientSCA).catch(() => null);
      if (clientAgentId) {
        try {
          await recordLedgerEntry({
            ...usdcLedgerIdentity(), // Phase 2D: explicitly USDC-only (6-dec USDC budget)
            agentRegistryId: clientAgentId,
            type: "JOB_ESCROW_LOCK",
            amount: BigInt(job.budget),
            direction: "DEBIT",
            jobId: BigInt(jobId),
            txHash: fundTx,
            description: `escrow lock for job ${jobId}`,
          });
        } catch (e: any) { console.error("[ledger] fund lock failed:", e.message); }
      }
    } catch {}

    return NextResponse.json({ success: true, jobId, status: 'FUNDED', approveTx, fundTx });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export const POST = withApiKeyOrAnySession(fundJobHandler);
