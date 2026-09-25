// POST /api/agents/[id]/treasury/hire
// Autonomous subcontractor hire via treasury: caller proves control of the
// hiring agent (A), treasury policy + spend-limit checked, then hires
// provider agent B via createJob (same path as /api/agents/[id]/hire).
// This is the core economic loop of Build 3.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { resolveAgentRouteRef } from "@/lib/agents/resolveAgentRef";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { getCircleClient, waitForTransaction } from "@/lib/circle/client";
import { createPublicClient, http, decodeEventLog } from "viem";
import { getArcChain, getNetworkConfig } from "@/lib/config/network";
const arcTestnet = getArcChain();
import { agenticCommerceAbi } from "@/lib/contracts/erc8183";
import { hashCriteria } from "@/lib/jobs/criteriaHash";
import { evaluatePolicyForSpend, withTreasurySpendLock } from "@/lib/ledger/treasuryPolicy";
import { checkSpendAllowed } from "@/lib/agents/spendLimitEnforcer";
import { checkRateLimit } from "@/src/lib/ratelimit";

async function handler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // H9: payments-tier rate limit on this fund-moving POST.
  const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
  if (!allowed) return limitResponse!;
  const { id } = await ctx.params;
  // Canonical hirer reference: registry id, ERC-8004 tokenId, or SCA address
  // (auto, ambiguity refused). Caller-control, step-up, treasury/spend
  // policy and self-hire gates below all operate on the RESOLVED hirer —
  // unchanged.
  const { agent: hirerRef, ambiguous: hirerAmbiguous, malformed: hirerMalformed } = await resolveAgentRouteRef(id);
  if (hirerAmbiguous) return NextResponse.json({ error: "ambiguous agent reference" }, { status: 400 });
  if (hirerMalformed) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  if (!hirerRef) return NextResponse.json({ error: "hirer agent not found" }, { status: 404 });
  const hirerId = hirerRef.id;
  const body = await req.json().catch(() => ({}));
  const { providerAgentId, description, criteria, budget, evaluatorAddress, validation } = body;
  if (!providerAgentId || !description || !criteria || budget === undefined) {
    return NextResponse.json({ error: "providerAgentId, description, criteria, budget are required" }, { status: 400 });
  }
  if (!Array.isArray(criteria.requirements) || criteria.requirements.length === 0) {
    return NextResponse.json({ error: "criteria.requirements must be non-empty array" }, { status: 400 });
  }
  if (criteria.requirements.length > 50) return NextResponse.json({ error: "too many criteria — max 50" }, { status: 400 });
  const budgetBigInt = BigInt(Math.round(Number(budget) * 1_000_000));
  if (budgetBigInt <= 0n) return NextResponse.json({ error: "budget must be > 0" }, { status: 400 });

  const hirer = hirerRef;
  // Canonical provider reference (body): same three forms as the hirer.
  // Malformed provider refs keep the legacy "required" 400; well-formed but
  // unknown providers keep the legacy 404.
  const { agent: providerRef, ambiguous: providerAmbiguous, malformed: providerMalformed } = await resolveAgentRouteRef(providerAgentId);
  if (providerAmbiguous) return NextResponse.json({ error: "ambiguous provider agent reference" }, { status: 400 });
  if (providerMalformed) {
    return NextResponse.json({ error: "providerAgentId, description, criteria, budget are required" }, { status: 400 });
  }
  if (!providerRef) return NextResponse.json({ error: "provider agent not found" }, { status: 404 });
  const provider = providerRef;
  const providerId = provider.id;
  if (provider.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "provider not available" }, { status: 400 });

  // Caller must control hirer
  const hirerWallet = await getOrCreateAgentWallet(hirerId);
  const actor = await verifyCallerControlsAddress(req, hirer.scaAddress ?? hirerWallet.address);
  if (!actor) return NextResponse.json({ error: "You do not control the hiring agent." }, { status: 403 });

  // Consumer step-up (Stage 2) when the hiring party is consumer-controlled.
  const stepUp = await requireConsumerStepUpForActor(req, actor, "consumer.job-fund");
  if (stepUp) return stepUp;

  // H10: mandatory server idempotency key — concurrent retries with the same
  // key claim one PaymentLog row before any on-chain write; the loser replays.
  const rawKey = req.headers.get('idempotency-key')?.trim();
  if (!rawKey || rawKey.length > 120) {
    return NextResponse.json({ error: 'Idempotency-Key header (1-120 chars) is required.' }, { status: 400 });
  }
  const hireIdemKey = `treasury-hire:${hirerId}:${rawKey}`;
  const hireExisting = await (prisma as any).paymentLog.findUnique({ where: { idempotencyKey: hireIdemKey } }).catch(() => null);
  if (hireExisting) {
    return NextResponse.json({
      success: (hireExisting as any).status === 'SUCCESS',
      replayed: true,
      jobId: (hireExisting as any).gatewayReference ?? null,
      txHash: (hireExisting as any).arcTxHash ?? null,
    });
  }

  // Trust check FIRST (cheapest, no side effects) — if policy has minTrustScore, enforce before money checks
  const hirerPolicy: any = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: hirerId } }).catch(() => null);
  if (hirerPolicy?.minTrustScore !== null && hirerPolicy?.minTrustScore !== undefined) {
    const { computeTrustScore } = await import("@/lib/trust/trustScore");
    const providerTrust = await computeTrustScore(providerId);
    if (providerTrust.score < Number(hirerPolicy.minTrustScore)) {
      return NextResponse.json({ error: `Trust requirement not met: provider trust ${providerTrust.score} < required ${hirerPolicy.minTrustScore}`, code: "TRUST_REQUIREMENT_NOT_MET", providerTrust, required: hirerPolicy.minTrustScore }, { status: 403 });
    }
  }

  // Treasury policy check (fail-closed) — H10: serialized per hirer so
  // concurrent hires can't each read the same spentToday and both pass.
  const policyCheck = await withTreasurySpendLock(hirerId, async () =>
    evaluatePolicyForSpend({ agentRegistryId: hirerId, amount: budgetBigInt, kind: "subcontractor" })
  );
  if (!policyCheck.allowed) {
    return NextResponse.json({ error: `Treasury policy blocked: ${policyCheck.reason}` }, { status: 403 });
  }

  // Spend-limit check (hard boundary)
  const spendCheck = await checkSpendAllowed({ agentAddress: hirerWallet.address, amount: budgetBigInt });
  if (!spendCheck.allowed) {
    return NextResponse.json({ error: `Spend limit blocked: ${spendCheck.reason}` }, { status: 403 });
  }

  // Resolve hirer EOA as the Circle wallet — hiring uses Circle SCA pattern,
  // but hire route requires clientWalletId that resolves to clientSCA.
  // For treasury hire, the hirer's SCA is the client if it has a Circle wallet,
  // otherwise we require the caller to supply hirerCircleWalletId explicitly.
  // Prefer the hirer's Circle SCA if available.
  let clientAddress: string;
  let clientWalletIdForFund: string | null = null;
  if (hirer.circleWalletId) {
    const circleClient = getCircleClient();
    try {
      const w = await circleClient.getWallet({ id: hirer.circleWalletId });
      clientAddress = w.data?.wallet?.address as string;
      clientWalletIdForFund = hirer.circleWalletId;
      if (!clientAddress) throw new Error("no address");
      // also ensure this wallet is the hirer's SCA? circleWallet address == SCA for SCA wallets
      if (clientAddress.toLowerCase() !== hirer.scaAddress?.toLowerCase()) {
        // hirer's SCA != circle wallet — use circle wallet address as client
      }
    } catch {
      return NextResponse.json({ error: "hirer has no resolvable Circle wallet; provide hirerCircleWalletId" }, { status: 400 });
    }
  } else if (body.hirerCircleWalletId) {
    const circleClient = getCircleClient();
    const w = await circleClient.getWallet({ id: body.hirerCircleWalletId });
    clientAddress = w.data?.wallet?.address as string;
    if (!clientAddress) return NextResponse.json({ error: "invalid hirerCircleWalletId" }, { status: 400 });
    const controls = await verifyCallerControlsAddress(req, clientAddress);
    if (!controls) return NextResponse.json({ error: "You do not control hirerCircleWalletId" }, { status: 403 });
    clientWalletIdForFund = body.hirerCircleWalletId;
  } else {
    return NextResponse.json({ error: "hirer has no Circle wallet — set one or provide hirerCircleWalletId" }, { status: 400 });
  }

  // Self-hire guard: same policy as POST /api/agents/[id]/hire — hiring yourself is rejected
  // outright rather than silently excluded from trust (see trustScore.ts). Prevents no-op escrow
  // jobs that would otherwise waste gas and could be used to probe trust boundaries.
  if (String(clientAddress).toLowerCase() === String(provider.scaAddress).toLowerCase()) {
    return NextResponse.json({ error: "self-hire not allowed: hirer and provider cannot be the same address" }, { status: 400 });
  }

  // M1: shared validator serviceability gate (CIRCLE custody + live
  // getWallet address match) — see src/lib/validators/serviceability.ts.
  let validationPolicy: any = null;
  if (validation && validation.required) {
    const validatorSCA = String(validation.validatorSCA || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(validatorSCA)) return NextResponse.json({ error: "validation.validatorSCA must be valid 0x address" }, { status: 400 });
    if (validatorSCA.toLowerCase() === clientAddress.toLowerCase()) return NextResponse.json({ error: "validator cannot be client" }, { status: 400 });
    if (validatorSCA.toLowerCase() === provider.scaAddress?.toLowerCase()) return NextResponse.json({ error: "validator cannot be provider" }, { status: 400 });
    const { assertValidatorServiceable } = await import("@/lib/validators/serviceability");
    const serviceable = await assertValidatorServiceable(validatorSCA);
    if (!serviceable.ok) return NextResponse.json({ error: (serviceable as any).error }, { status: 400 });
    validationPolicy = { validatorSCA: validatorSCA.toLowerCase(), tag: validation.tag || null };
  }

  // ERC-8183 contract address resolves from the authoritative network config
  // (mainnet-aware) — never a static testnet pin or an env override.
  const escrowContract = getNetworkConfig().erc8183Address as `0x${string}`;
  const circleClient = getCircleClient();
  const expiredAt = Math.floor(Date.now() / 1000) + (criteria.deadlineUnix ? criteria.deadlineUnix - Math.floor(Date.now()/1000) : 86400);
  const evaluator = evaluatorAddress || clientAddress;

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientAddress,
    blockchain: getNetworkConfig().circleBlockchain,
    contractAddress: escrowContract,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [provider.scaAddress, evaluator, expiredAt.toString(), description, "0x0000000000000000000000000000000000000000"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  // H10: claim the idempotency row BEFORE waiting on-chain, so a retry
  // racing this hire replays instead of double-hiring. P2002 → replay.
  try {
    await (prisma as any).paymentLog.create({
      data: {
        reference: `treasury_hire_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        idempotencyKey: hireIdemKey,
        amount: Number(budgetBigInt) / 1e6,
        currency: 'USDC',
        chain: 'Arc Testnet v1.0',
        senderEmail: clientAddress,
        merchant: `treasury-hire:${hirerId}`,
        agentSCA: hirer.scaAddress ?? null,
        status: 'PROCESSING',
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const winner = await (prisma as any).paymentLog.findUnique({ where: { idempotencyKey: hireIdemKey } }).catch(() => null);
      return NextResponse.json({ success: (winner as any)?.status === 'SUCCESS', replayed: true, jobId: (winner as any)?.gatewayReference ?? null, txHash: (winner as any)?.arcTxHash ?? null });
    }
    throw e;
  }
  const txHash = await waitForTransaction(createTx.data?.id!, "create job (treasury hire)");
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

  const job = await prisma.erc8183Job.create({
    data: {
      jobId,
      clientSCA: clientAddress,
      providerSCA: provider.scaAddress,
      evaluatorSCA: evaluator,
      description,
      budget: budgetBigInt,
      status: "OPEN",
      txHashes: [txHash],
      expiredAt: new Date(expiredAt * 1000),
      merchantId: (actor as any).id ?? null,
    },
  });

  if (validationPolicy) {
    const { createJobValidationPolicy } = await import("@/lib/jobs/jobValidationPolicy");
    try { await createJobValidationPolicy(jobId, validationPolicy.validatorSCA, validationPolicy.tag); } catch (e: any) { console.error("validation policy create failed:", e.message); }
  }

  // H10: bind the idempotency row to the created job for replays.
  await (prisma as any).paymentLog.update({
    where: { idempotencyKey: hireIdemKey },
    data: { status: 'SUCCESS', arcTxHash: txHash, gatewayReference: jobId.toString() },
  }).catch(() => {});

  // Ledger: hirer subcontractor spend is not recorded until funded/released (escrow lock at fund, spend at release).
  // We record a pending intent as metadata only if needed; for now the hire itself is not a ledger event.

  return NextResponse.json({
    success: true,
    jobId: jobId.toString(),
    dbId: job.id,
    txHash,
    hirer: { id: hirer.id, scaAddress: hirer.scaAddress },
    provider: { id: provider.id, scaAddress: provider.scaAddress },
    budget: budgetBigInt.toString(),
    nextSteps: { fund: { endpoint: "/api/jobs/fund", body: { jobId: jobId.toString(), clientWalletId: clientWalletIdForFund } } },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession((inner: NextRequest) => handler(inner, ctx))(req);
}
