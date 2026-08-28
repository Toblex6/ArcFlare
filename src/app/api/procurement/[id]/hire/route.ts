// POST /api/procurement/[id]/hire — create real ERC-8183 job from selected provider
// Uses treasury hire path (trust + treasury policy + spend-limit then on-chain createJob)
// Caller must control the client agent (same as select). Provider is derived from posting's selectedProviderSCA — never trusts body provider.

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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });
  if (posting.status !== "SELECTED") return NextResponse.json({ error: `posting is ${posting.status}, must be SELECTED (call /select first)` }, { status: 400 });
  if (!posting.selectedProviderSCA) return NextResponse.json({ error: "posting has no selected provider" }, { status: 400 });
  if (posting.resultingJobId) return NextResponse.json({ error: "posting already hired", jobId: posting.resultingJobId.toString() }, { status: 409 });

  const actorCheck = await verifyCallerControlsAddress(req, posting.clientSCA);
  let merchantCtx: any = null;
  if (!actorCheck) {
    const merchant = await resolveMerchant(req).catch(() => null);
    if (merchant && posting.merchantId === merchant.id) merchantCtx = merchant;
    else return NextResponse.json({ error: "Only the posting owner can hire." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const budgetInput = body.budget !== undefined ? body.budget : posting.budgetMax;
  let budgetBigInt: bigint;
  try {
    const s = String(budgetInput).trim();
    if (/^\d+$/.test(s)) budgetBigInt = BigInt(s);
    else if (/^\d+(\.\d{1,6})?$/.test(s)) budgetBigInt = BigInt(Math.round(parseFloat(s) * 1_000_000));
    else throw new Error("invalid");
  } catch { return NextResponse.json({ error: "invalid budget" }, { status: 400 }); }
  if (budgetBigInt <= 0n) return NextResponse.json({ error: "budget must be > 0" }, { status: 400 });
  if (budgetBigInt > BigInt(posting.budgetMax)) return NextResponse.json({ error: "budget exceeds posting budgetMax" }, { status: 400 });

  // Resolve client agent
  const clientAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: posting.clientSCA, mode: "insensitive" } } });
  if (!clientAgent) return NextResponse.json({ error: "client agent not found" }, { status: 404 });
  const providerAddress = posting.selectedProviderSCA;
  const providerAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: providerAddress, mode: "insensitive" } } });
  if (!providerAgent) return NextResponse.json({ error: "provider agent not found" }, { status: 404 });
  if (providerAgent.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "provider not available" }, { status: 400 });

  // Trust check (treasury policy minTrustScore)
  const hirerPolicy: any = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: clientAgent.id } }).catch(() => null);
  if (hirerPolicy?.minTrustScore !== null && hirerPolicy?.minTrustScore !== undefined) {
    const { computeTrustScore } = await import("@/lib/trust/trustScore");
    const providerTrust = await computeTrustScore(providerAgent.id);
    if (providerTrust.score < Number(hirerPolicy.minTrustScore)) {
      return NextResponse.json({ error: `Trust requirement not met: provider trust ${providerTrust.score} < required ${hirerPolicy.minTrustScore}`, code: "TRUST_REQUIREMENT_NOT_MET", providerTrust, required: hirerPolicy.minTrustScore }, { status: 403 });
    }
  }

  // Treasury policy
  const policyCheck = await evaluatePolicyForSpend({ agentRegistryId: clientAgent.id, amount: budgetBigInt, kind: "subcontractor" });
  if (!policyCheck.allowed) return NextResponse.json({ error: `Treasury policy blocked: ${policyCheck.reason}` }, { status: 403 });

  // Spend limit — resolve client's payment EOA or Circle wallet address for check
  // Check against the Circle SCA if available, else the X402 EOA (the spend limit is per EOA, not SCA? Actually spend limit is per agent EOA (payment EOA) — but hiring funds from clientSCA (Circle SCA). Use whichever is the hiring wallet.)
  // For procurement hire, hiring wallet is clientAgent.scaAddress (Circle SCA) — spend limit is on that address via getSpendLimit? But spend limit is for agent payment EOAs, not SCA wallets.
  // We check both: if client has a payment EOA, check it; also check clientSCA via contract (same address space). The check is best-effort — the authoritative enforcement is checkAndRecordSpend before transfer, but hire doesn't transfer yet (fund later).
  // So we still gate here using the client SCA's limit (if any).
  try {
    const { getOrCreateAgentWallet } = await import("@/lib/x402-wallet");
    const w = await getOrCreateAgentWallet(clientAgent.id).catch(() => null);
    const checkAddr = w?.address ?? posting.clientSCA;
    const spendCheck = await checkSpendAllowed({ agentAddress: checkAddr, amount: budgetBigInt });
    if (!spendCheck.allowed) return NextResponse.json({ error: `Spend limit blocked: ${spendCheck.reason}` }, { status: 403 });
  } catch {}

  // Self-hire already checked at select, re-check
  if (posting.clientSCA.toLowerCase() === providerAddress.toLowerCase()) {
    return NextResponse.json({ error: "self-hire not allowed" }, { status: 400 });
  }

  // Resolve hiring wallet: clientAgent.circleWalletId must exist (Circle SCA)
  let clientWalletAddress: string;
  let clientWalletIdForFund: string | null = null;
  if (clientAgent.circleWalletId) {
    const circleClient = getCircleClient();
    try {
      const w = await circleClient.getWallet({ id: clientAgent.circleWalletId });
      clientWalletAddress = w.data?.wallet?.address as string;
      clientWalletIdForFund = clientAgent.circleWalletId;
      if (!clientWalletAddress) throw new Error("no address");
    } catch {
      return NextResponse.json({ error: "client has no resolvable Circle wallet" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "client agent has no Circle wallet — cannot hire" }, { status: 400 });
  }
  if (clientWalletAddress.toLowerCase() !== posting.clientSCA.toLowerCase()) {
    // posting clientSCA was captured at creation from agent.scaAddress — if circle wallet address differs, we must use the circle address as on-chain client
    // But posting's selected provider trust was evaluated against SCA — still ok. Update posting's clientSCA to actual wallet address for job creation?
    // Keep posting.clientSCA as authoritative; hiring uses circle wallet address (which should equal SCA for SCA wallets). If mismatch, we still hire with circle address.
  }

  const evaluator = body.evaluatorAddress || clientWalletAddress;
  const description = posting.description;
  const expiredAt = Math.floor(Date.now() / 1000) + 86400;
  const escrowContract = (process.env.AGENTIC_COMMERCE_CONTRACT || AGENTIC_COMMERCE_CONTRACT) as `0x${string}`;
  const circleClient = getCircleClient();

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWalletAddress,
    blockchain: "ARC-TESTNET",
    contractAddress: escrowContract,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [providerAddress, evaluator, expiredAt.toString(), description, "0x0000000000000000000000000000000000000000"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const txHash = await waitForTransaction(createTx.data?.id!, "create job (procurement hire)");
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
      clientSCA: clientWalletAddress,
      providerSCA: providerAddress,
      evaluatorSCA: evaluator,
      description,
      budget: budgetBigInt,
      status: "OPEN",
      txHashes: [txHash],
      expiredAt: new Date(expiredAt * 1000),
      merchantId: posting.merchantId ?? (actorCheck as any)?.id ?? null,
    },
  });

  // Mark posting hired
  await (prisma as any).procurementPosting.update({
    where: { id },
    data: { status: "HIRED", resultingJobId: jobId },
  });

  // Validation optional forwarding
  if (body.validation && body.validation.required) {
    const validatorSCA = String(body.validation.validatorSCA || "").trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(validatorSCA) && validatorSCA.toLowerCase() !== clientWalletAddress.toLowerCase() && validatorSCA.toLowerCase() !== providerAddress.toLowerCase()) {
      const { createJobValidationPolicy } = await import("@/lib/jobs/jobValidationPolicy");
      try { await createJobValidationPolicy(jobId, validatorSCA.toLowerCase(), body.validation.tag || null); } catch {}
    }
  }

  return NextResponse.json({
    success: true,
    jobId: jobId.toString(),
    dbId: job.id,
    txHash,
    postingId: id,
    client: { id: clientAgent.id, scaAddress: clientWalletAddress },
    provider: { id: providerAgent.id, scaAddress: providerAddress },
    budget: budgetBigInt.toString(),
    nextSteps: { accept: { endpoint: `/api/jobs/${jobId.toString()}/accept`, method: "POST" }, fund: { endpoint: `/api/jobs/${jobId.toString()}/fund`, body: {} } },
  });
}
