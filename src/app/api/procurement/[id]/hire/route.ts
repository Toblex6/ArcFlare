// POST /api/procurement/[id]/hire — create real ERC-8183 job from selected provider
// Uses treasury hire path (trust + treasury policy + spend-limit then on-chain createJob)
// Caller must control the client agent (same as select). Provider is derived from posting's selectedProviderSCA — never trusts body provider.
//
// Idempotency (Build 5 repair): hire claims the posting atomically with a
// conditional status flip SELECTED → HIRING using updateMany where status still
// equals SELECTED. Two concurrent hires cannot both win the claim, so a posting
// can never produce more than one on-chain job. The resulting job row + HIRED
// marker are committed in one Prisma transaction. Failure rolls the claim back
// to SELECTED (or, if the on-chain createJob already landed, a stale-HIRING
// takeover re-uses the orphan row instead of re-creating the job).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getCircleClient, waitForTransaction } from "@/lib/circle/client";
import { createPublicClient, http, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from "@/lib/contracts/erc8183";
import { evaluatePolicyForSpend } from "@/lib/ledger/treasuryPolicy";
import { checkSpendAllowed } from "@/lib/agents/spendLimitEnforcer";

const STALE_HIRING_MS = 5 * 60 * 1000;
const ORPHAN_WINDOW_MS = 6 * 60 * 60 * 1000;
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });

  // ── Idempotent short-circuit: already hired returns the existing result ─────
  if (posting.status === "HIRED") {
    if (posting.resultingJobId) {
      const existing = await prisma.erc8183Job.findUnique({ where: { jobId: posting.resultingJobId } });
      if (existing) {
        return NextResponse.json({ success: true, replayed: true, jobId: posting.resultingJobId.toString(), dbId: existing.id, status: "HIRED", message: "Posting already hired — replay" });
      }
    }
    return NextResponse.json({ error: "posting is already HIRED" }, { status: 409 });
  }

  // Auth before mutating anything.
  const actorCheck = await verifyCallerControlsAddress(req, posting.clientSCA);
  let merchantCtx: any = null;
  if (!actorCheck) {
    const merchant = await resolveMerchant(req).catch(() => null);
    if (merchant && posting.merchantId === merchant.id) merchantCtx = merchant;
    else return NextResponse.json({ error: "Only the posting owner can hire." }, { status: 403 });
  }
  if (!posting.selectedProviderSCA) return NextResponse.json({ error: "posting has no selected provider" }, { status: 400 });

  // ── Conditional claim: SELECTED → HIRING (only one winner) ───────────────────
  // A stale HIRING claim (older than STALE_HIRING_MS) can be taken over — the
  // previous attempt may have crashed after createJob but before the DB commit;
  // the orphan scan below re-uses that on-chain job instead of duplicating it.
  let tookOverStale = false;
  if (posting.status === "SELECTED") {
    const claim = await (prisma as any).procurementPosting.updateMany({
      where: { id, status: "SELECTED" },
      data: { status: "HIRING" },
    });
    if (claim.count !== 1) {
      // Lost the race — re-check; a concurrent request may have finished.
      const fresh = await (prisma as any).procurementPosting.findUnique({ where: { id } });
      if (fresh?.status === "HIRED" && fresh.resultingJobId) {
        const existingJob = await prisma.erc8183Job.findUnique({ where: { jobId: fresh.resultingJobId } });
        if (existingJob) return NextResponse.json({ success: true, replayed: true, jobId: fresh.resultingJobId.toString(), dbId: existingJob.id, status: "HIRED", message: "Posting hired by a concurrent request — replay" });
      }
      return NextResponse.json({ error: "hire already in progress for this posting", status: fresh?.status ?? posting.status }, { status: 409 });
    }
  } else if (posting.status === "HIRING") {
    const staleCutoff = new Date(Date.now() - STALE_HIRING_MS);
    if (posting.updatedAt > staleCutoff) {
      return NextResponse.json({ error: "hire already in progress for this posting" }, { status: 409 });
    }
    const takeover = await (prisma as any).procurementPosting.updateMany({
      where: { id, status: "HIRING", updatedAt: { lt: staleCutoff } },
      data: { status: "HIRING" },
    });
    if (takeover.count !== 1) {
      return NextResponse.json({ error: "hire in progress", status: "HIRING" }, { status: 409 });
    }
    tookOverStale = true;
  } else {
    return NextResponse.json({ error: `posting is ${posting.status}, must be SELECTED (call /select first)` }, { status: 400 });
  }

  // Release the claim on any early failure path (nothing was created on-chain
  // yet — a retry can attempt a fresh createJob).
  const releaseClaim = async () => {
    await (prisma as any).procurementPosting.updateMany({
      where: { id, status: "HIRING" },
      data: { status: "SELECTED" },
    }).catch(() => {});
  };
  const fail = async (error: string, status = 400, extra: any = {}) => {
    await releaseClaim();
    return NextResponse.json({ error, ...extra }, { status });
  };

  const body = await req.json().catch(() => ({}));
  const budgetInput = body.budget !== undefined ? body.budget : posting.budgetMax;
  let budgetBigInt: bigint;
  try {
    const s = String(budgetInput).trim();
    if (/^\d+$/.test(s)) budgetBigInt = BigInt(s);
    else if (/^\d+(\.\d{1,6})?$/.test(s)) budgetBigInt = BigInt(Math.round(parseFloat(s) * 1_000_000));
    else throw new Error("invalid");
  } catch { return await fail("invalid budget"); }
  if (budgetBigInt <= 0n) return await fail("budget must be > 0");
  if (budgetBigInt > BigInt(posting.budgetMax)) return await fail("budget exceeds posting budgetMax");

  // Resolve client agent
  const clientAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: posting.clientSCA, mode: "insensitive" } } });
  if (!clientAgent) return await fail("client agent not found", 404);
  const providerAddress = posting.selectedProviderSCA;

  // ── Provider resolution (never trusts a caller-supplied wallet/address) ─────
  // The provider is whatever address the posting's SELECTED application
  // recorded (select only accepts rows from this posting's applicant set).
  // Two legitimate identities:
  //   - AgentRegistry agent   → agent acceptance/trust policy applies.
  //   - Telegram human worker → ConsumerAccount (own Circle wallet, no
  //     AgentRegistry row). Identity + wallet ownership + job acceptance
  //     apply; agent-specific policy does not. Neutral trust baseline 50.
  const providerAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: providerAddress, mode: "insensitive" } } });
  let humanProvider: any = null;
  if (providerAgent) {
    if (providerAgent.status !== "ACTIVE_AGENT_PROVISIONED") return await fail("provider not available");
  } else {
    humanProvider = await (prisma as any).consumerAccount.findFirst({
      where: { walletAddress: { equals: providerAddress, mode: "insensitive" } },
    });
    // An arbitrary address that merely exists in ConsumerAccount is NOT
    // sufficient — the worker must have a usable Circle wallet to be paid.
    if (!humanProvider || !humanProvider.circleWalletId || !humanProvider.walletAddress) {
      return await fail("selected provider has no usable wallet to be paid", 400);
    }
  }

  // Resolve hiring wallet FIRST — it is the payer identity that authorizes the
  // on-chain createJob (and later the fund), so all policy checks bind to it.
  let clientWalletAddress: string;
  if (clientAgent.circleWalletId) {
    const circleClient = getCircleClient();
    try {
      const w = await circleClient.getWallet({ id: clientAgent.circleWalletId });
      clientWalletAddress = w.data?.wallet?.address as string;
      if (!clientWalletAddress) throw new Error("no address");
    } catch {
      return await fail("client has no resolvable Circle wallet", 400);
    }
  } else {
    return await fail("client agent has no Circle wallet — cannot hire", 400);
  }
  // Fail closed on wallet/SCA mismatch: the on-chain client, the poster's SCA,
  // and the policy-check identity must all be the same address.
  if (clientWalletAddress.toLowerCase() !== posting.clientSCA.toLowerCase()) {
    return await fail("client Circle wallet does not match posting clientSCA — cannot hire", 400);
  }

  // Self-hire rejected at the hire boundary (already checked at select).
  if (posting.clientSCA.toLowerCase() === providerAddress.toLowerCase()) {
    return await fail("self-hire not allowed");
  }

  // Evaluator — D11: validate format and require evaluator != provider.
  const evaluator = body.evaluatorAddress ? String(body.evaluatorAddress).trim() : clientWalletAddress;
  if (!/^0x[a-fA-F0-9]{40}$/.test(evaluator)) {
    return await fail("invalid evaluatorAddress");
  }
  if (evaluator.toLowerCase() === providerAddress.toLowerCase()) {
    return await fail("evaluator must be distinct from the provider");
  }

  // Trust check (treasury policy minTrustScore) — AGENT providers only.
  // Agent providers: derived trust score (validated evidence-aware). Telegram
  // human providers: neutral baseline 50 (no agent history) — same rule the
  // select route applies; a policy demanding more than neutral rejects.
  const hirerPolicy: any = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: clientAgent.id } }).catch(() => null);
  if (hirerPolicy?.minTrustScore !== null && hirerPolicy?.minTrustScore !== undefined) {
    const required = Number(hirerPolicy.minTrustScore);
    let providerTrustScore = required; // humans default to neutral 50
    if (providerAgent) {
      const { computeTrustScore } = await import("@/lib/trust/trustScore");
      const providerTrust = await computeTrustScore(providerAgent.id);
      providerTrustScore = providerTrust.score;
    } else if (50 < required) {
      return await fail(`Trust requirement not met: provider has no trust history (neutral 50) < required ${required}`, 403, { code: "TRUST_REQUIREMENT_NOT_MET", required });
    }
    if (providerTrustScore < required) {
      return await fail(`Trust requirement not met: provider trust ${providerTrustScore} < required ${required}`, 403, { code: "TRUST_REQUIREMENT_NOT_MET", required });
    }
  }

  // Treasury policy
  const policyCheck = await evaluatePolicyForSpend({ agentRegistryId: clientAgent.id, amount: budgetBigInt, kind: "subcontractor" });
  if (!policyCheck.allowed) return await fail(`Treasury policy blocked: ${policyCheck.reason}`, 403);

  // Spend-limit pre-flight on the ACTUAL client payer (the Circle SCA that will
  // sign the on-chain createJob and the later fund). No EOA fallback, no
  // swallowed errors. The authoritative on-chain record of the actual fund
  // happens in fund — hire itself moves no value, so it is not recorded here.
  const spendCheck = await checkSpendAllowed({ agentAddress: clientWalletAddress, amount: budgetBigInt });
  if (!spendCheck.allowed) return await fail(`Spend limit blocked: ${spendCheck.reason}`, 403);

  const description = posting.description;
  const expiredAt = Math.floor(Date.now() / 1000) + 86400;
  const escrowContract = (process.env.AGENTIC_COMMERCE_CONTRACT || AGENTIC_COMMERCE_CONTRACT) as `0x${string}`;
  const circleClient = getCircleClient();

  // If we took over a STALE HIRING claim, the previous attempt may have already
  // created the on-chain job (crash after createJob, before the DB commit).
  // Reuse that orphan instead of creating a second one — one-posting→one-job.
  // Only a stale takeover should scan for an orphan — a fresh SELECTED→HIRING
  // claim has never created a job.
  if (tookOverStale) {
    const orphan = await (prisma as any).erc8183Job.findFirst({
      where: {
        clientSCA: { equals: clientWalletAddress, mode: "insensitive" },
        providerSCA: { equals: providerAddress, mode: "insensitive" },
        description,
        status: { in: ["OPEN", "FUNDED", "SUBMITTED"] },
        createdAt: { gte: new Date(Date.now() - ORPHAN_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (orphan) {
      await (prisma as any).procurementPosting.update({
        where: { id },
        data: { status: "HIRED", resultingJobId: orphan.jobId },
      });
      return NextResponse.json({ success: true, replayed: true, jobId: orphan.jobId.toString(), dbId: orphan.id, status: "HIRED", message: "Reused orphaned on-chain job from a prior interrupted hire" });
    }
  }

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWalletAddress,
    blockchain: "ARC-TESTNET",
    contractAddress: escrowContract,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [providerAddress, evaluator, expiredAt.toString(), description, "0x0000000000000000000000000000000000000000"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!createTx.data?.id) {
    return await fail("createJob returned no transaction ID", 500);
  }

  let txHash: string;
  try {
    txHash = await waitForTransaction(createTx.data.id, "create job (procurement hire)");
  } catch (e: any) {
    // On-chain createJob failed/timed out — release the claim so a retry can
    // attempt a fresh createJob (no job was created, nothing to orphan).
    return await fail(`create job failed: ${e?.message ?? e}`, 500);
  }
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  let jobId: bigint | null = null;
  try {
    const log = receipt.logs.find((l) => l.address.toLowerCase() === escrowContract.toLowerCase());
    const parsed = log ? decodeEventLog({ abi: agenticCommerceAbi as any, data: log.data, topics: log.topics, eventName: "JobCreated" }) : null;
    if (parsed?.args) jobId = BigInt((parsed.args as any).jobId ?? (parsed.args as any).id ?? 0);
  } catch {}
  if (!jobId || jobId === 0n) {
    const next = await publicClient.readContract({ address: escrowContract, abi: agenticCommerceAbi as any, functionName: "jobCounter" }) as bigint;
    jobId = next - 1n;
  }

  // ── Persist job + HIRED marker atomically so the invariant holds even if ──
  // this process dies right now: the on-chain job and its DB mirror are written
  // (or not written) together. One posting → one authoritative resulting job.
  let job: any;
  try {
    const [createdJob] = await prisma.$transaction([
      prisma.erc8183Job.create({
        data: {
          jobId: jobId!,
          clientSCA: clientWalletAddress,
          providerSCA: providerAddress,
          evaluatorSCA: evaluator,
          description,
          budget: budgetBigInt,
          status: "OPEN",
          txHashes: [txHash],
          expiredAt: new Date(expiredAt * 1000),
          merchantId: posting.merchantId ?? (actorCheck as any)?.id ?? merchantCtx?.id ?? null,
        },
      }),
      (prisma as any).procurementPosting.update({
        where: { id },
        data: { status: "HIRED", resultingJobId: jobId! },
      }),
    ]);
    job = createdJob;
  } catch (e: any) {
    // The on-chain job may or may not have landed here; leave the claim at
    // HIRING (stale recovery will reuse the orphan) rather than risking a
    // duplicate createJob by rolling back to SELECTED.
    return NextResponse.json({ error: `hire persist failed: ${e?.message ?? e}`, jobId: jobId?.toString() }, { status: 500 });
  }

  // Validation optional forwarding
  if (body.validation && body.validation.required) {
    const validatorSCA = String(body.validation.validatorSCA || "").trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(validatorSCA) && validatorSCA.toLowerCase() !== clientWalletAddress.toLowerCase() && validatorSCA.toLowerCase() !== providerAddress.toLowerCase()) {
      const { createJobValidationPolicy } = await import("@/lib/jobs/jobValidationPolicy");
      try { await createJobValidationPolicy(jobId!, validatorSCA.toLowerCase(), body.validation.tag || null); } catch {}
    }
  }

  // ── Notify the hired worker on Telegram (best-effort — never fails hire) ────
  // Human workers get the actionable nudge at the moment it matters: the
  // on-chain job exists, and the next step is THEIR signature (budget accept).
  try {
    const hired = humanProvider
      ? humanProvider
      : await (prisma as any).consumerAccount.findFirst({ where: { walletAddress: { equals: providerAddress, mode: "insensitive" } } });
    const workerTelegramId = hired?.telegramUserId ?? null;
    if (workerTelegramId) {
      const { sendTelegramMessage } = await import("@/lib/telegram/sendTelegramMessage");
      const { formatUnits } = await import("viem");
      const title = (posting.title || description).slice(0, 80);
      const budgetStr = (() => { try { return formatUnits(budgetBigInt, 6); } catch { return "?"; } })();
      await sendTelegramMessage(
        String(workerTelegramId),
        `✅ You've been hired for "${title}" — job #${jobId!.toString()} (${budgetStr} USDC).\nSend /accept ${jobId!.toString()} to set your budget and unlock funding.`
      );
    }
  } catch (e: any) {
    console.error("[hire] worker telegram notification failed:", e?.message ?? e);
  }

  return NextResponse.json({
    success: true,
    jobId: jobId!.toString(),
    dbId: job.id,
    txHash,
    postingId: id,
    client: { id: clientAgent.id, scaAddress: clientWalletAddress },
    provider: { id: providerAgent?.id ?? null, scaAddress: providerAddress, human: !!humanProvider },
    budget: budgetBigInt.toString(),
    nextSteps: { accept: { endpoint: `/api/jobs/${jobId!.toString()}/accept`, method: "POST" }, fund: { endpoint: `/api/jobs/${jobId!.toString()}/fund`, body: {} } },
  });
}
