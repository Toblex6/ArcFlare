import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getJobValidationPolicy, recordValidationRequest } from "@/lib/jobs/jobValidationPolicy";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, keccak256, toHex } from "viem";

const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as `0x${string}`;

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY!, entitySecret: process.env.CIRCLE_ENTITY_SECRET! });
}
async function waitForTx(client: ReturnType<typeof getCircleClient>, txId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) return data.transaction.txHash;
    if (data?.transaction?.state === "FAILED") {
      console.error("Validation transaction failed:", JSON.stringify(data.transaction, null, 2));
      throw new Error(`Validation transaction failed onchain: ${data.transaction.errorReason || JSON.stringify(data.transaction)}`);
    }
  }
  throw new Error("Validation transaction timed out.");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const handler = async (innerReq: NextRequest) => {
    const { jobId } = await params;
    const jobIdBigInt = BigInt(jobId);
    const job = await prisma.erc8183Job.findUnique({ where: { jobId: jobIdBigInt } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const policy = await getJobValidationPolicy(jobIdBigInt);
    if (!policy || !policy.required) return NextResponse.json({ error: "No validation required for this job — cannot request validation" }, { status: 400 });
    if (policy.requestHash) {
      return NextResponse.json({ success: true, jobId, requestHash: policy.requestHash, requestTxHash: policy.requestTxHash, status: policy.status, message: "Validation already requested — idempotent replay", replayed: true });
    }
    const callerControlsClient = await verifyCallerControlsAddress(innerReq, job.clientSCA);
    const callerControlsProvider = await verifyCallerControlsAddress(innerReq, job.providerSCA);
    if (!callerControlsClient && !callerControlsProvider) {
      return NextResponse.json({ error: "You must control the job's client or provider to request validation" }, { status: 403 });
    }
    const agent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: job.providerSCA, mode: "insensitive" } } });
    if (!agent) return NextResponse.json({ error: "Provider agent not found in registry — cannot request validation" }, { status: 404 });
    const requestTag = `job-${jobId}-validation`;
    const requestURI = `ipfs://arcflare-job-${jobId}-validation-${requestTag}`;
    const requestHash = keccak256(toHex(`flarehq_job_validation_${jobId}_${policy.validatorSCA}_${Date.now()}`)) as `0x${string}`;
    const circleClient = getCircleClient();
    // Use validationRequest(validator, agentId, requestURI, requestHash) — matches deployed contract at 0x8004Cb1B...
    // For job validation, the provider agent is being validated, so the sender must be the provider's owner (agent.scaAddress)
    // The validator is the designated job validator (policy.validatorSCA)
    const signingWalletForRequest = agent.scaAddress;
    const signerIsProviderOwner = await verifyCallerControlsAddress(innerReq, signingWalletForRequest);
    if (!signerIsProviderOwner) {
      return NextResponse.json({ error: "You must control the provider agent's wallet to request validation for its work" }, { status: 403 });
    }
    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress: signingWalletForRequest,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: VALIDATION_REGISTRY,
      abiFunctionSignature: "validationRequest(address,uint256,string,bytes32)",
      abiParameters: [policy.validatorSCA, agent.tokenId.toString(), requestURI, requestHash],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    if (!tx.data?.id) throw new Error("Circle transaction returned no ID.");
    const txHash = await waitForTx(circleClient, tx.data.id);
    const updated = await recordValidationRequest(jobIdBigInt, requestHash, txHash);
    return NextResponse.json({ success: true, jobId, agentId: agent.tokenId, validatorSCA: policy.validatorSCA, requestHash, requestURI, txHash, explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`, status: updated.status, message: `Validation requested for job ${jobId} — validator ${policy.validatorSCA} must now respond` });
  };
  return withApiKeyOrAnySession(handler as any)(req);
}
