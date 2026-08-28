// POST /api/jobs/[jobId]/fund — client autonomous fund (approve + fund)
// Resolves client wallet from AgentRegistry.circleWalletId — never trusts caller-supplied walletId.
// Verifies caller controls job.clientSCA, treasury policy, spend limit, then approve+fund.
// Idempotent: if job status already FUNDED, replays.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getCircleClient, createContractTransaction } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT, USDC_CONTRACT } from "@/lib/contracts/erc8183";
import { evaluatePolicyForSpend } from "@/lib/ledger/treasuryPolicy";
import { checkSpendAllowed } from "@/lib/agents/spendLimitEnforcer";

async function handler(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  let jobIdBig: bigint;
  try { jobIdBig = BigInt(jobId); } catch { return NextResponse.json({ error: "invalid jobId" }, { status: 400 }); }

  const job = await prisma.erc8183Job.findUnique({ where: { jobId: jobIdBig } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status === "FUNDED") {
    return NextResponse.json({ success: true, replayed: true, jobId, status: "FUNDED", message: "Job already funded — replay" });
  }
  if (job.status !== "OPEN") return NextResponse.json({ error: `Job is ${job.status}, not OPEN — cannot fund` }, { status: 409 });
  if (job.budget <= 0n) return NextResponse.json({ error: "Job budget is 0 — provider must accept/setBudget first" }, { status: 409 });

  // Caller must control client
  const actor = await verifyCallerControlsAddress(req, job.clientSCA);
  if (!actor) return NextResponse.json({ error: "You do not control this job's client wallet." }, { status: 403 });

  // Resolve client agent and authoritative Circle wallet
  const clientAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: job.clientSCA, mode: "insensitive" } } });
  if (!clientAgent) return NextResponse.json({ error: "client agent not found" }, { status: 404 });
  if (!clientAgent.circleWalletId) return NextResponse.json({ error: "client agent has no Circle wallet for funding" }, { status: 400 });

  const circleClient = getCircleClient();
  let clientWalletAddress: string;
  try {
    const w = await circleClient.getWallet({ id: clientAgent.circleWalletId });
    clientWalletAddress = w.data?.wallet?.address as string;
    if (!clientWalletAddress) throw new Error("no address");
  } catch {
    return NextResponse.json({ error: "client Circle wallet not resolvable" }, { status: 400 });
  }
  if (clientWalletAddress.toLowerCase() !== job.clientSCA.toLowerCase()) {
    return NextResponse.json({ error: "client Circle wallet does not match job clientSCA" }, { status: 403 });
  }

  // Policy checks — re-evaluate at fund time (treasury may have changed since hire)
  const policyCheck = await evaluatePolicyForSpend({ agentRegistryId: clientAgent.id, amount: BigInt(job.budget), kind: "subcontractor" });
  if (!policyCheck.allowed) return NextResponse.json({ error: `Treasury policy blocked: ${policyCheck.reason}` }, { status: 403 });

  try {
    const w = await prisma.x402EoaWallet.findUnique({ where: { agentRegistryId: clientAgent.id } }).catch(() => null);
    const checkAddr = w?.address ?? clientWalletAddress;
    const spendCheck = await checkSpendAllowed({ agentAddress: checkAddr, amount: BigInt(job.budget) });
    if (!spendCheck.allowed) return NextResponse.json({ error: `Spend limit blocked: ${spendCheck.reason}` }, { status: 403 });
  } catch {}

  // Approve USDC (idempotent approve — contract overwrites) then fund
  let approveTx: string;
  try {
    approveTx = await createContractTransaction(
      clientWalletAddress,
      USDC_CONTRACT,
      'approve(address,uint256)',
      [AGENTIC_COMMERCE_CONTRACT, job.budget.toString()],
      'approve USDC'
    );
  } catch (e: any) {
    return NextResponse.json({ error: `approve failed: ${e.message}` }, { status: 500 });
  }

  let fundTx: string;
  try {
    fundTx = await createContractTransaction(
      clientWalletAddress,
      AGENTIC_COMMERCE_CONTRACT,
      'fund(uint256,bytes)',
      [jobId, '0x'],
      'fund escrow'
    );
  } catch (e: any) {
    return NextResponse.json({ error: `fund failed: ${e.message}`, approveTx }, { status: 500 });
  }

  await prisma.erc8183Job.update({
    where: { jobId: jobIdBig },
    data: { status: "FUNDED", txHashes: { push: [approveTx, fundTx] } },
  });

  // Ledger: escrow lock for client if agent — awaited
  try {
    const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
    const clientAgentId = await resolveAgentIdBySca(job.clientSCA).catch(() => null);
    if (clientAgentId) {
      try {
        await recordLedgerEntry({
          agentRegistryId: clientAgentId,
          type: "JOB_ESCROW_LOCK",
          amount: BigInt(job.budget),
          direction: "DEBIT",
          jobId: jobIdBig,
          txHash: fundTx,
          description: `escrow lock for job ${jobId}`,
        });
      } catch (e: any) { console.error("[ledger] fund lock failed:", e.message); }
    }
  } catch {}

  return NextResponse.json({ success: true, jobId, status: "FUNDED", approveTx, fundTx });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withApiKeyOrAnySession(handler as any)(req);
}
