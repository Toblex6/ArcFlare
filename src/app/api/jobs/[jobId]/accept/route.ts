// POST /api/jobs/[jobId]/accept — provider autonomous acceptance (setBudget)
// The provider's own Circle wallet signs setBudget; no caller-supplied wallet ID is trusted.
// Enforces provider's acceptance policy (minBudget, maxConcurrent, minClientTrust, skills).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getCircleClient, createContractTransaction } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT } from "@/lib/contracts/erc8183";
import { evaluateProviderAcceptance } from "@/lib/procurement/procurementService";

async function handler(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const jobIdBig = (() => { try { return BigInt(jobId); } catch { return null; } })();
  if (!jobIdBig) return NextResponse.json({ error: "invalid jobId" }, { status: 400 });

  const job = await prisma.erc8183Job.findUnique({ where: { jobId: jobIdBig } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "OPEN") return NextResponse.json({ error: `Job is ${job.status}, not OPEN — cannot accept` }, { status: 409 });

  // Caller must control the job's provider SCA
  const actor = await verifyCallerControlsAddress(req, job.providerSCA);
  if (!actor) return NextResponse.json({ error: "You do not control this job's provider wallet." }, { status: 403 });

  // Resolve provider agent to get authoritative wallet and policy
  const providerAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: job.providerSCA, mode: "insensitive" } } });
  if (!providerAgent) return NextResponse.json({ error: "provider agent not found" }, { status: 404 });
  if (!providerAgent.circleWalletId) return NextResponse.json({ error: "provider has no Circle wallet to sign setBudget" }, { status: 400 });

  // Verify the caller's control was via the authoritative address (already done), but also ensure the Circle wallet resolves to same SCA (fail closed on mismatch)
  const circleClient = getCircleClient();
  let providerWalletAddress: string;
  try {
    const w = await circleClient.getWallet({ id: providerAgent.circleWalletId });
    providerWalletAddress = w.data?.wallet?.address as string;
    if (!providerWalletAddress) throw new Error("no address");
  } catch {
    return NextResponse.json({ error: "provider Circle wallet not resolvable" }, { status: 400 });
  }
  if (providerWalletAddress.toLowerCase() !== job.providerSCA.toLowerCase()) {
    return NextResponse.json({ error: "provider Circle wallet does not match job providerSCA — cannot sign" }, { status: 403 });
  }

  // Idempotency: if budget already set (>0) and on-chain status would be >Open, treat as replay
  // Check on-chain budget via public client? Simpler: if job.budget >0 in DB, return replay (DB is mirror after successful setBudget)
  if (job.budget > 0n) {
    return NextResponse.json({ success: true, replayed: true, jobId, budget: job.budget.toString(), message: "Budget already set — replay" });
  }

  // Provider policy evaluation
  const policyCheck = await evaluateProviderAcceptance({
    providerAgentId: providerAgent.id,
    jobBudget: BigInt(job.budget) > 0n ? BigInt(job.budget) : BigInt(job.budget || "0"), // job.budget is 0 before accept in procurement flow? In treasury/hire the budget is set at creation (non-zero). For open postings created with 0, budget is 0. But we need the posted budgetMax as acceptance signal. For now use job.budget (0 means unknown) — fallback to provider minBudget check only when >0.
    // For procurement hires, job.budget IS the hire budget (non-zero), so this works.
    clientSCA: job.clientSCA,
    skill: null,
    category: null,
  });

  // But if job.budget is 0 (generic open), we need to evaluate against the budget we will set. The request body may carry budget? For autonomous accept, the provider sets the budget ITSELF — the budget is the client's offer (job.budget). So we check provider minBudget against job.budget.
  // If job.budget is 0, the provider cannot know budget; we require budget to be set at job creation (procurement hire ensures it). So re-evaluate with actual budget:
  let evalBudget = BigInt(job.budget);
  const body = await req.json().catch(() => ({}));
  if (evalBudget === 0n && body.budget) {
    try {
      const s = String(body.budget).trim();
      if (/^\d+$/.test(s)) evalBudget = BigInt(s);
      else if (/^\d+(\.\d{1,6})?$/.test(s)) evalBudget = BigInt(Math.round(parseFloat(s) * 1_000_000));
    } catch {}
  }
  // Re-evaluate if budget changed
  if (evalBudget !== BigInt(job.budget)) {
    const second = await evaluateProviderAcceptance({
      providerAgentId: providerAgent.id,
      jobBudget: evalBudget,
      clientSCA: job.clientSCA,
      skill: null,
      category: null,
    });
    if (!second.allowed) return NextResponse.json({ error: `Provider policy rejected: ${second.reason}`, code: "PROVIDER_POLICY_REJECTED" }, { status: 403 });
  } else {
    if (!policyCheck.allowed) return NextResponse.json({ error: `Provider policy rejected: ${policyCheck.reason}`, code: "PROVIDER_POLICY_REJECTED" }, { status: 403 });
  }

  // Also enforce trust requirement if provider has minClientTrustScore — already done in evaluateProviderAcceptance
  // Determine the budget to set: if job already has budget (procurement hire), reuse it; else use body's budget or max
  let budgetToSet = evalBudget;
  if (budgetToSet === 0n) {
    // No budget known — use proposed amount from procurement application? Not available here — require body budget
    return NextResponse.json({ error: "job budget is 0 — provide budget in body or ensure job was hired with a budget" }, { status: 400 });
  }

  // Provider signs setBudget (idempotent on-chain? setBudget can only be called once while OPEN; replay will revert)
  // Never trust body providerWalletId — resolved above.
  let txHash: string;
  try {
    txHash = await createContractTransaction(
      providerWalletAddress,
      AGENTIC_COMMERCE_CONTRACT,
      'setBudget(uint256,uint256,bytes)',
      [jobId, budgetToSet.toString(), '0x'],
      'set budget (provider accept)'
    );
  } catch (e: any) {
    // If revert due to already set, treat as replay if DB still 0
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  await prisma.erc8183Job.update({
    where: { jobId: jobIdBig },
    data: { budget: budgetToSet, txHashes: { push: txHash } },
  });

  return NextResponse.json({ success: true, jobId, budget: budgetToSet.toString(), txHash, provider: { id: providerAgent.id, scaAddress: providerWalletAddress } });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withApiKeyOrAnySession(handler as any)(req);
}
