// POST /api/jobs/[jobId]/accept — provider autonomous acceptance (setBudget)
// The provider's own Circle wallet signs setBudget; no caller-supplied wallet ID is trusted.
// Enforces provider's acceptance policy (minBudget, maxConcurrent, minClientTrust, skills).
//
// Replay semantics (Build 5 repair): replay state is determined from the
// AUTHORITATIVE on-chain job via getJob(jobId). The DB `budget` column holds
// the procurement hire's INTENDED budget, persisted before the on-chain
// setBudget transaction — a non-zero DB budget does NOT prove setBudget ran.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getCircleClient, createContractTransaction } from "@/lib/circle/client";
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from "@/lib/contracts/erc8183";
import { evaluateProviderAcceptance } from "@/lib/procurement/procurementService";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";

// The chain the ERC-8183 contract lives on (same RPC wiring as the hire route).
const RPC_URL = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";

async function readOnChainJob(jobIdBig: bigint): Promise<{ budget: bigint; status: number } | null> {
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
  const job = (await publicClient.readContract({
    address: AGENTIC_COMMERCE_CONTRACT as `0x${string}`,
    abi: agenticCommerceAbi as any,
    functionName: "getJob",
    args: [jobIdBig],
  })) as any;
  // getJob struct components: id, client, provider, evaluator, description,
  // budget, expiredAt, status, hook.
  return { budget: BigInt(job.budget ?? 0), status: Number(job.status ?? 0) };
}

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

  // Fail closed on wallet/SCA mismatch: only the provider's authoritative
  // Circle wallet may sign setBudget.
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

// POST /api/jobs/[jobId]/accept — provider autonomous acceptance (setBudget)
// ── Replay determined from AUTHORITATIVE on-chain state ──────────────────────
  // DB `job.budget` is the procurement hire's INTENDED budget (persisted at
  // hire time, BEFORE setBudget). It is not proof setBudget executed. Only the
  // chain proves that.
  let onChain: { budget: bigint; status: number } | null = null;
  try {
    onChain = await readOnChainJob(jobIdBig);
  } catch (e: any) {
    return NextResponse.json({ error: `on-chain job read failed: ${e?.message ?? e}` }, { status: 502 });
  }
  if (!onChain) return NextResponse.json({ error: "on-chain job not found" }, { status: 404 });

  if (onChain.status !== 0) {
    // Not OPEN on-chain. If a budget is set, this is a genuine replay; else the
    // job has moved past the acceptance window and setBudget would revert.
    if (onChain.budget > 0n) {
      // Reconcile the DB mirror with the authoritative chain state.
      if (job.budget !== onChain.budget) {
        await prisma.erc8183Job.update({ where: { jobId: jobIdBig }, data: { budget: onChain.budget } }).catch(() => {});
      }
      return NextResponse.json({ success: true, replayed: true, jobId, budget: onChain.budget.toString(), onChainStatus: onChain.status, message: "Budget already set on-chain — replay" });
    }
    return NextResponse.json({ error: `job is not OPEN on-chain (status ${onChain.status}) — cannot accept` }, { status: 409 });
  }
  if (onChain.budget > 0n) {
    // Still OPEN on-chain but budget already set — setBudget already happened.
    if (job.budget !== onChain.budget) {
      await prisma.erc8183Job.update({ where: { jobId: jobIdBig }, data: { budget: onChain.budget } }).catch(() => {});
    }
    return NextResponse.json({ success: true, replayed: true, jobId, budget: onChain.budget.toString(), onChainStatus: onChain.status, message: "Budget already set on-chain — replay" });
  }

  // ── Budget to set ────────────────────────────────────────────────────────────
  // DB intended budget (procurement hire) takes precedence; else the request
  // body may propose one (only when the job has no intended budget).
  const body = await req.json().catch(() => ({}));
  let budgetToSet = job.budget > 0n ? job.budget : 0n;
  if (budgetToSet === 0n && body.budget !== undefined && body.budget !== null && body.budget !== "") {
    try {
      const s = String(body.budget).trim();
      if (/^\d+$/.test(s)) budgetToSet = BigInt(s);
      else if (/^\d+(\.\d{1,6})?$/.test(s)) budgetToSet = BigInt(Math.round(parseFloat(s) * 1_000_000));
    } catch {}
  }
  if (budgetToSet === 0n) {
    return NextResponse.json({ error: "no budget to set — job has no intended budget and none was provided" }, { status: 400 });
  }

  // ── Provider policy evaluation (D3: real skill/category from procurement) ────
  // The procurement posting that produced this job carries the posting's
  // skill/category — flow them into the provider policy evaluation instead of
  // hardcoding null.
  let skill: string | null = null;
  let category: string | null = null;
  try {
    const posting = await (prisma as any).procurementPosting.findFirst({
      where: { resultingJobId: jobIdBig },
      select: { skill: true, category: true },
    });
    if (posting) {
      skill = posting.skill ?? null;
      category = posting.category ?? null;
    }
  } catch {}

  const policyCheck = await evaluateProviderAcceptance({
    providerAgentId: providerAgent.id,
    jobBudget: budgetToSet,
    clientSCA: job.clientSCA,
    skill,
    category,
    // The job being accepted is itself OPEN; don't let it count against the
    // provider's own maxConcurrentJobs.
    excludeJobId: jobIdBig,
  });
  if (!policyCheck.allowed) {
    return NextResponse.json({ error: `Provider policy rejected: ${policyCheck.reason}`, code: "PROVIDER_POLICY_REJECTED" }, { status: 403 });
  }

  // Provider signs setBudget (idempotent on-chain? setBudget can only be called
  // once while OPEN; replay will revert). Never trust body providerWalletId.
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
    // A revert here may mean a concurrent accept already set the budget.
    // Re-check the chain before reporting failure so a raced double-accept
    // still surfaces as a replay rather than a 500.
    try {
      const after = await readOnChainJob(jobIdBig);
      if (after && after.budget > 0n) {
        return NextResponse.json({ success: true, replayed: true, jobId, budget: after.budget.toString(), message: "Budget already set on-chain — replay" });
      }
    } catch {}
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  await prisma.erc8183Job.update({
    where: { jobId: jobIdBig },
    data: { budget: budgetToSet, txHashes: { push: txHash } },
  });

  return NextResponse.json({ success: true, jobId, budget: budgetToSet.toString(), txHash, provider: { id: providerAgent.id, scaAddress: providerWalletAddress } });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  // Forward the route context into the wrapped handler — the auth wrapper only
  // receives the request, so the [jobId] params must close over ctx (same
  // pattern as /api/agents/[id]/acceptance-policy).
  return withApiKeyOrAnySession((inner: NextRequest) => handler(inner, ctx))(req);
}
