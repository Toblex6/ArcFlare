// src/app/api/agents/[id]/hire/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getCircleClient, waitForTransaction } from "@/lib/circle/client";
import { createPublicClient, http, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from "@/lib/contracts/erc8183";
import { hashCriteria } from "@/lib/jobs/criteriaHash";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const handler = async (innerReq: NextRequest) => {
    const { id } = await params;
    const agentId = Number(id);
    if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
    const body = await innerReq.json().catch(() => ({}));
    const { clientWalletId, description, criteria, budget, evaluatorAddress, validation } = body;
    if (!clientWalletId || !description || !criteria || budget === undefined) return NextResponse.json({ error: "clientWalletId, description, criteria, budget are required" }, { status: 400 });
    if (!Array.isArray(criteria.requirements) || criteria.requirements.length === 0) return NextResponse.json({ error: "criteria.requirements must be non-empty array" }, { status: 400 });
    const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
    if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    if (agent.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "agent not available" }, { status: 400 });
    const circleClient = getCircleClient();
    const wallet = await circleClient.getWallet({ id: clientWalletId });
    const clientAddress = wallet.data?.wallet?.address;
    if (!clientAddress) return NextResponse.json({ error: "Invalid clientWalletId" }, { status: 400 });
    const actor = await verifyCallerControlsAddress(innerReq, clientAddress);
    if (!actor) return NextResponse.json({ error: "You do not control the payer wallet" }, { status: 403 });
    const providerAddress = agent.scaAddress;
    // Self-hire guard: client === provider is rejected outright (mirrors self-validation guard below).
    // Rationale: hiring yourself via escrow is a no-op (funds round-trip minus gas/fees) and would
    // inflate trust if counted. We fail closed at the API boundary rather than silently discounting
    // later — see trustScore.ts selfHireJobIds exclusion. If a legitimate self-test is needed, use
    // a distinct test wallet or bypass via direct DB seeding.
    if (String(clientAddress).toLowerCase() === String(providerAddress).toLowerCase()) {
      return NextResponse.json({ error: "self-hire not allowed: client and provider cannot be the same address" }, { status: 400 });
    }
    const evaluator = evaluatorAddress || clientAddress;
    const budgetBigInt = BigInt(Math.round(Number(budget) * 1_000_000));
    if (budgetBigInt <= 0n) return NextResponse.json({ error: "budget must be > 0" }, { status: 400 });
    // Optional validation policy (Build 2: validation-gated jobs)
    let validationPolicy: any = null;
    if (validation && validation.required) {
      const validatorSCA = String(validation.validatorSCA || "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(validatorSCA)) {
        return NextResponse.json({ error: "validation.validatorSCA must be a valid 0x address" }, { status: 400 });
      }
      // Prevent obvious self-validation: validator should not be the client or the provider
      const agentForCheck = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId }, select: { scaAddress: true } });
      const providerForCheck = agentForCheck?.scaAddress?.toLowerCase();
      if (validatorSCA.toLowerCase() === clientAddress.toLowerCase()) {
        return NextResponse.json({ error: "validator cannot be the job client (self-validation)" }, { status: 400 });
      }
      if (providerForCheck && validatorSCA.toLowerCase() === providerForCheck) {
        return NextResponse.json({ error: "validator cannot be the job provider (self-validation)" }, { status: 400 });
      }
      // Store for later creation after job is persisted
      validationPolicy = { validatorSCA: validatorSCA.toLowerCase(), tag: validation.tag || null };
    }

    const fullCriteria = { jobId: `temp-${Date.now()}`, description, requirements: criteria.requirements, deadlineUnix: criteria.deadlineUnix || Math.floor(Date.now()/1000) + 86400 };
    const expiredAt = fullCriteria.deadlineUnix;
    const escrowContract = (process.env.AGENTIC_COMMERCE_CONTRACT || AGENTIC_COMMERCE_CONTRACT) as `0x${string}`;
    const createTx = await circleClient.createContractExecutionTransaction({ walletAddress: clientAddress, blockchain: "ARC-TESTNET", contractAddress: escrowContract, abiFunctionSignature: "createJob(address,address,uint256,string,address)", abiParameters: [providerAddress, evaluator, expiredAt.toString(), description, "0x0000000000000000000000000000000000000000"], fee: { type: "level", config: { feeLevel: "MEDIUM" } } });
    const txHash = await waitForTransaction(createTx.data?.id!, "create job");
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    let jobId: bigint | null = null;
    try { const log = receipt.logs.find((l) => l.address.toLowerCase() === escrowContract.toLowerCase()); const parsed = log ? decodeEventLog({ abi: agenticCommerceAbi as any, data: log.data, topics: log.topics, eventName: "JobCreated" }) : null; if (parsed?.args) jobId = BigInt((parsed.args as any).jobId ?? (parsed.args as any).id ?? 0); } catch (e) { console.warn("decode failed", e); }
    if (!jobId || jobId === 0n) { const next = await publicClient.readContract({ address: escrowContract, abi: agenticCommerceAbi as any, functionName: "jobCounter" }) as bigint; jobId = next - 1n; }
    const job = await prisma.erc8183Job.create({ data: { jobId, clientSCA: clientAddress, providerSCA: providerAddress, evaluatorSCA: evaluator, description, budget: budgetBigInt, status: "OPEN", txHashes: [txHash], expiredAt: new Date(expiredAt * 1000), merchantId: (actor as any).id ?? null } });
    let createdValidation: any = null;
    if (validationPolicy) {
      const { createJobValidationPolicy } = await import("@/lib/jobs/jobValidationPolicy");
      try {
        createdValidation = await createJobValidationPolicy(jobId, validationPolicy.validatorSCA, validationPolicy.tag);
      } catch (e: any) {
        console.error("Failed to create job validation policy:", e.message);
        // Do not fail the hire if validation policy creation fails; the job is already created.
        // The caller can retry creating the validation requirement via the validation endpoint.
      }
    }
    const criteriaHash = hashCriteria({ jobId: jobId.toString(), description, requirements: criteria.requirements, deadlineUnix: expiredAt } as any);
    return NextResponse.json({ success: true, jobId: jobId.toString(), dbId: job.id, txHash, status: "OPEN", agent: { id: agent.id, tokenId: agent.tokenId, name: agent.name, scaAddress: agent.scaAddress }, criteriaHash, validation: createdValidation ? { required: true, validatorSCA: createdValidation.validatorSCA, status: createdValidation.status } : null, nextSteps: { setBudget: { endpoint: "/api/jobs/set-budget", body: { jobId: jobId.toString(), providerWalletId: agent.circleWalletId, budget: budgetBigInt.toString() } }, fund: { endpoint: "/api/jobs/fund", body: { jobId: jobId.toString(), clientWalletId } }, requestValidation: createdValidation ? { endpoint: `/api/jobs/${jobId.toString()}/validation/request`, body: { validatorSCA: createdValidation.validatorSCA } } : null } });
  };
  return withApiKeyOrAnySession(handler as any)(req);
}
