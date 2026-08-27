// POST /api/agents/[id]/treasury/hire
// Autonomous subcontractor hire via treasury: caller proves control of the
// hiring agent (A), treasury policy + spend-limit checked, then hires
// provider agent B via createJob (same path as /api/agents/[id]/hire).
// This is the core economic loop of Build 3.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { getCircleClient, waitForTransaction } from "@/lib/circle/client";
import { createPublicClient, http, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from "@/lib/contracts/erc8183";
import { hashCriteria } from "@/lib/jobs/criteriaHash";
import { evaluatePolicyForSpend } from "@/lib/ledger/treasuryPolicy";
import { checkSpendAllowed } from "@/lib/agents/spendLimitEnforcer";

async function handler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hirerId = Number(id);
  if (!Number.isInteger(hirerId) || hirerId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { providerAgentId, description, criteria, budget, evaluatorAddress, validation } = body;
  const providerId = Number(providerAgentId);
  if (!providerId || !description || !criteria || budget === undefined) {
    return NextResponse.json({ error: "providerAgentId, description, criteria, budget are required" }, { status: 400 });
  }
  if (!Array.isArray(criteria.requirements) || criteria.requirements.length === 0) {
    return NextResponse.json({ error: "criteria.requirements must be non-empty array" }, { status: 400 });
  }
  if (criteria.requirements.length > 50) return NextResponse.json({ error: "too many criteria — max 50" }, { status: 400 });
  const budgetBigInt = BigInt(Math.round(Number(budget) * 1_000_000));
  if (budgetBigInt <= 0n) return NextResponse.json({ error: "budget must be > 0" }, { status: 400 });

  const hirer = await (prisma as any).agentRegistry.findUnique({ where: { id: hirerId } });
  if (!hirer) return NextResponse.json({ error: "hirer agent not found" }, { status: 404 });
  const provider = await (prisma as any).agentRegistry.findUnique({ where: { id: providerId } });
  if (!provider) return NextResponse.json({ error: "provider agent not found" }, { status: 404 });
  if (provider.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "provider not available" }, { status: 400 });

  // Caller must control hirer
  const hirerWallet = await getOrCreateAgentWallet(hirerId);
  const actor = await verifyCallerControlsAddress(req, hirer.scaAddress ?? hirerWallet.address);
  if (!actor) return NextResponse.json({ error: "You do not control the hiring agent." }, { status: 403 });

  // Treasury policy check (fail-closed)
  const policyCheck = await evaluatePolicyForSpend({ agentRegistryId: hirerId, amount: budgetBigInt, kind: "subcontractor" });
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

  // Validation optional
  let validationPolicy: any = null;
  if (validation && validation.required) {
    const validatorSCA = String(validation.validatorSCA || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(validatorSCA)) return NextResponse.json({ error: "validation.validatorSCA must be valid 0x address" }, { status: 400 });
    if (validatorSCA.toLowerCase() === clientAddress.toLowerCase()) return NextResponse.json({ error: "validator cannot be client" }, { status: 400 });
    if (validatorSCA.toLowerCase() === provider.scaAddress?.toLowerCase()) return NextResponse.json({ error: "validator cannot be provider" }, { status: 400 });
    validationPolicy = { validatorSCA: validatorSCA.toLowerCase(), tag: validation.tag || null };
  }

  const escrowContract = (process.env.AGENTIC_COMMERCE_CONTRACT || AGENTIC_COMMERCE_CONTRACT) as `0x${string}`;
  const circleClient = getCircleClient();
  const expiredAt = Math.floor(Date.now() / 1000) + (criteria.deadlineUnix ? criteria.deadlineUnix - Math.floor(Date.now()/1000) : 86400);
  const evaluator = evaluatorAddress || clientAddress;

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientAddress,
    blockchain: "ARC-TESTNET",
    contractAddress: escrowContract,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [provider.scaAddress, evaluator, expiredAt.toString(), description, "0x0000000000000000000000000000000000000000"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
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
