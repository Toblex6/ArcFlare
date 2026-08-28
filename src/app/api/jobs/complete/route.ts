import { NextRequest, NextResponse } from 'next/server';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT } from '@/lib/contracts/erc8183';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { keccak256, toHex } from 'viem';
import { isValidationSatisfiedForJob } from '@/lib/jobs/jobValidationPolicy';

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

    // Build 2: validation-gated release — if this job has a validation policy, require PASS
    const validationCheck = await isValidationSatisfiedForJob(BigInt(jobId));
    if (!validationCheck.allowed) {
      return NextResponse.json(
        {
          error: `Validation required — ${validationCheck.reason}`,
          code: "VALIDATION_REQUIRED",
          validationStatus: validationCheck.reason,
        },
        { status: 409 }
      );
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

    // Build 3 ledger: provider revenue (exactly once) + client spend + client lock clear.
    // Awaited at the authoritative point — durable before the response.
    try {
      const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
      const { getJobValidationPolicy } = await import("@/lib/jobs/jobValidationPolicy");
      let jobValidationId: string | null = null;
      try {
        const pol = await getJobValidationPolicy(BigInt(jobId));
        if (pol && pol.required) jobValidationId = pol.id;
      } catch {}
      const providerAgentId = await resolveAgentIdBySca(job.providerSCA).catch(() => null);
      const clientAgentId = await resolveAgentIdBySca(job.clientSCA).catch(() => null);

      if (providerAgentId) {
        try {
          await recordLedgerEntry({
            agentRegistryId: providerAgentId,
            type: "REVENUE",
            amount: BigInt(job.budget),
            direction: "CREDIT",
            jobId: BigInt(jobId),
            jobValidationId,
            txHash,
            description: jobValidationId ? `validated revenue for job ${jobId}` : `revenue from job ${jobId}`,
            metadata: jobValidationId ? { validationLinked: true } : undefined,
          });
        } catch (e: any) { console.error("[ledger] revenue credit failed:", e.message); }
      }

      if (clientAgentId) {
        // Clear the fund-time JOB_ESCROW_LOCK — smallest consistent representation.
        try {
          await recordLedgerEntry({
            agentRegistryId: clientAgentId,
            type: "JOB_ESCROW_RELEASE",
            amount: BigInt(job.budget),
            direction: "CREDIT",
            jobId: BigInt(jobId),
            jobValidationId,
            txHash,
            description: `escrow unlock for job ${jobId}`,
          });
        } catch (e: any) { console.error("[ledger] escrow unlock failed:", e.message); }
        // Actual economic spend — distinct from the lock.
        if (clientAgentId !== providerAgentId) {
          try {
            await recordLedgerEntry({
              agentRegistryId: clientAgentId,
              type: "SUBCONTRACTOR_SPEND",
              amount: BigInt(job.budget),
              direction: "DEBIT",
              counterpartyAgentId: providerAgentId ?? null,
              jobId: BigInt(jobId),
              jobValidationId,
              txHash,
              description: `subcontractor spend for job ${jobId}`,
            });
          } catch {}
        }
      }
    } catch {}

    // Build 4: auto-reputation from validated completion (awaited, deduped, no fire-and-forget)
    // Only for validated jobs that passed; self-feedback/hiring excluded inside the helper.
    try {
      const { maybeAutoReputationForValidatedJob } = await import("@/lib/trust/autoReputation");
      const { resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
      const { getJobValidationPolicy } = await import("@/lib/jobs/jobValidationPolicy");
      let jv: any = null;
      try { jv = await getJobValidationPolicy(BigInt(jobId)); } catch {}
      if (jv && jv.required) {
        const providerAgentId = await resolveAgentIdBySca(job.providerSCA).catch(() => null);
        let providerTokenId: string | null = null;
        if (providerAgentId) {
          try { const ag: any = await (prisma as any).agentRegistry.findUnique({ where: { id: providerAgentId }, select: { tokenId: true } }); providerTokenId = String(ag?.tokenId ?? ""); } catch {}
          if (!providerTokenId) providerTokenId = null;
        }
        const rep = await maybeAutoReputationForValidatedJob({ jobId: BigInt(jobId), providerAgentId, providerTokenId, jobValidationId: jv.id, txHash });
        console.log(`[autoReputation] job ${jobId} ->`, rep);
      }
    } catch (e: any) { console.error("[autoReputation] failed:", e?.message); }

    return NextResponse.json({ success: true, jobId, status: 'COMPLETED', txHash });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export const POST = withApiKeyOrAnySession(completeJobHandler);
