// POST /api/jobs/[jobId]/fund — client autonomous fund (approve + fund)
// Resolves client wallet from AgentRegistry.circleWalletId — never trusts caller-supplied walletId.
// Verifies caller controls job.clientSCA, treasury policy, spend limit, then approve+fund.
// Idempotent: if job status already FUNDED, replays.
//
// Spend-limit (Build 5 repair): the check and the authoritative on-chain
// record (checkAndRecordSpend) are applied to the ACTUAL payer — the Circle
// SCA that signs approve/fund — not to some unrelated x402 EOA. Enforcement
// runs BEFORE any on-chain funding is attempted and never swallows errors.
//
// Manage funding (src/app/jobs/page.tsx) prefers this route and falls back
// to POST /api/jobs { action: 'fund' } ONLY for non-agent-client jobs (see
// NON_AGENT_CLIENT_FUND_ERRORS there) — never past a policy denial. Direct
// Hire jobs whose client is a merchant/consumer wallet (no AgentRegistry
// row) keep working through that legacy owner flow.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { getCircleClient, createContractTransaction } from "@/lib/circle/client";
import { getNetworkConfig } from "@/lib/config/network";
import { erc8183AddressOr503 } from "@/lib/jobs/erc8183Guard";
import { evaluatePolicyForSpend, withTreasurySpendLock } from "@/lib/ledger/treasuryPolicy";
import { checkSpendAllowed, getSpendLimitContract } from "@/lib/agents/spendLimitEnforcer";
import { checkRateLimit } from "@/src/lib/ratelimit";

// ERC-8183 contract + USDC token address resolve from the authoritative
// network config (mainnet-aware) — never static testnet pins in erc8183.ts.
// ERC-8183 resolves per-request via erc8183AddressOr503() (fail-closed 503
// when the external protocol address is unconfigured), never at module level.
const USDC_ADDRESS = getNetworkConfig().usdcAddress as `0x${string}`;

async function handler(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const erc8183 = erc8183AddressOr503();
  if ("response" in erc8183) return erc8183.response;
  const ERC8183_ADDRESS = erc8183.address;
  // H9: payments-tier rate limit on this fund-moving POST.
  const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
  if (!allowed) return limitResponse!;
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

  // Consumer step-up (Stage 2) for consumer clients.
  const stepUp = await requireConsumerStepUpForActor(req, actor, "consumer.job-fund");
  if (stepUp) return stepUp;

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

  // The actual payer for the approve/fund transactions IS clientWalletAddress
  // (the Circle SCA derived above). All spend-limit enforcement binds to it.
  const payer = clientWalletAddress;

  // H10: serialize the cap-check → on-chain fund → escrow-lock debit per
  // agent. Daily-cap evaluation is read-then-debit; without the lock two
  // concurrent funds could each read the same spentToday and both pass.
  // The JOB_ESCROW_LOCK DEBIT recorded below counts toward the cap (the
  // policy query sums all DEBIT entries), so holding the lock across the
  // check and the lock-write makes the cap atomic. Server idempotency: the
  // fundTx hash keys the ledger entry and the FUNDED transition is a
  // conditional claim (status OPEN → FUNDED); replays return the winner.
  return withTreasurySpendLock(clientAgent.id, async () => {
  // Policy checks — re-evaluate at fund time (treasury may have changed since hire)
  const policyCheck = await evaluatePolicyForSpend({ agentRegistryId: clientAgent.id, amount: BigInt(job.budget), kind: "subcontractor" });
  if (!policyCheck.allowed) return NextResponse.json({ error: `Treasury policy blocked: ${policyCheck.reason}` }, { status: 403 });

  // ── Spend-limit enforcement on the ACTUAL payer ──────────────────────────────
  // 1. Pre-flight view: a clean, fast 403 if the cap would be exceeded — no
  //    funding attempted at all.
  const spendCheck = await checkSpendAllowed({ agentAddress: payer, amount: BigInt(job.budget) });
  if (!spendCheck.allowed) return NextResponse.json({ error: `Spend limit blocked: ${spendCheck.reason}` }, { status: 403 });

  // 2. Authoritative on-chain record (relayer-signed checkAndRecordSpend)
  //    BEFORE any funding transaction. This is the hard enforcement write and
  //    the source of "spend counter actually records the spend". It reverts if
  //    a concurrent spend pushed the payer over cap. Errors are NOT swallowed:
  //    a failure here means no funds move and the request fails closed.
  try {
    const spendTx = await getSpendLimitContract().checkAndRecordSpend(payer, BigInt(job.budget));
    await spendTx.wait();
  } catch (spendLimitError: any) {
    return NextResponse.json({ error: `Spend limit enforcement failed: ${spendLimitError?.message ?? spendLimitError}` }, { status: 500 });
  }

  // Approve USDC (idempotent approve — contract overwrites) then fund
  let approveTx: string;
  try {
    approveTx = await createContractTransaction(
      payer,
      USDC_ADDRESS,
      'approve(address,uint256)',
      [ERC8183_ADDRESS, job.budget.toString()],
      'approve USDC'
    );
  } catch (e: any) {
    return NextResponse.json({ error: `approve failed: ${e.message}` }, { status: 500 });
  }

  let fundTx: string;
  try {
    fundTx = await createContractTransaction(
      payer,
      ERC8183_ADDRESS,
      'fund(uint256,bytes)',
      [jobId, '0x'],
      'fund escrow'
    );
  } catch (e: any) {
    return NextResponse.json({ error: `fund failed: ${e.message}`, approveTx }, { status: 500 });
  }

  // H10: conditional claim — only OPEN may transition to FUNDED. A
  // concurrent fund that won the race leaves FUNDED; we replay it.
  const fundedClaim = await prisma.erc8183Job.updateMany({
    where: { jobId: jobIdBig, status: "OPEN" },
    data: { status: "FUNDED", txHashes: { push: [approveTx, fundTx] } },
  });
  if (fundedClaim.count === 0) {
    const reread = await prisma.erc8183Job.findUnique({ where: { jobId: jobIdBig } });
    if (reread?.status === "FUNDED") {
      return NextResponse.json({ success: true, replayed: true, jobId, status: "FUNDED", message: "Job already funded — replay" });
    }
    return NextResponse.json({ error: `Job is ${reread?.status ?? "unknown"}, not OPEN — cannot fund` }, { status: 409 });
  }

  // Ledger: escrow lock for client if agent — awaited (non-fatal on failure)
  try {
    const { recordLedgerEntry, resolveAgentIdBySca, usdcLedgerIdentity } = await import("@/lib/ledger/ledgerService");
    const clientAgentId = await resolveAgentIdBySca(job.clientSCA).catch(() => null);
    if (clientAgentId) {
      await recordLedgerEntry({
        ...usdcLedgerIdentity(), // Phase 2D: explicitly USDC-only (6-dec USDC budget)
        agentRegistryId: clientAgentId,
        type: "JOB_ESCROW_LOCK",
        amount: BigInt(job.budget),
        direction: "DEBIT",
        jobId: jobIdBig,
        txHash: fundTx,
        description: `escrow lock for job ${jobId}`,
      });
    }
  } catch (e: any) { console.error("[ledger] fund lock failed:", e.message); }

  return NextResponse.json({ success: true, jobId, status: "FUNDED", approveTx, fundTx, payer });
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  // Forward the route context into the wrapped handler (see accept route).
  return withApiKeyOrAnySession((inner: NextRequest) => handler(inner, ctx))(req);
}