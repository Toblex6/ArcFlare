import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getJobValidationPolicy, recordValidationResponse } from "@/lib/jobs/jobValidationPolicy";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { keccak256, toHex } from "viem";

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
      throw new Error(`Validation transaction failed onchain: ${data.transaction.errorReason || data.transaction.errorDetails || JSON.stringify(data.transaction)}`);
    }
  }
  throw new Error("Validation transaction timed out.");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const handler = async (innerReq: NextRequest) => {
    const { jobId } = await params;
    const jobIdBigInt = BigInt(jobId);
    const body = await innerReq.json().catch(() => ({}));
    const { passed, tag } = body;
    if (passed === undefined || tag === undefined) {
      return NextResponse.json({ error: "passed (boolean) and tag (string) are required" }, { status: 400 });
    }
    const policy = await getJobValidationPolicy(jobIdBigInt);
    if (!policy || !policy.required) return NextResponse.json({ error: "No validation required for this job" }, { status: 400 });
    if (!policy.requestHash) return NextResponse.json({ error: "No validation request has been made for this job — cannot respond yet" }, { status: 400 });
    if (policy.status === "PASSED" || policy.status === "FAILED") {
      return NextResponse.json({ success: true, jobId, requestHash: policy.requestHash, status: policy.status, responseTxHash: policy.responseTxHash, message: `Validation already ${policy.status} — idempotent replay`, replayed: true });
    }
    const validatorSCA = policy.validatorSCA;
    const actor = await verifyCallerControlsAddress(innerReq, validatorSCA);
    if (!actor) return NextResponse.json({ error: "You do not control the designated validator wallet for this job" }, { status: 403 });
    const circleClient = getCircleClient();
    // Use validationResponse(requestHash, response, responseURI, responseHash, tag) — matches deployed contract at 0x8004Cb1B...
    const responseCode = passed ? 100 : 0;
    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress: validatorSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: VALIDATION_REGISTRY,
      abiFunctionSignature: "validationResponse(bytes32,uint8,string,bytes32,string)",
      abiParameters: [policy.requestHash!, responseCode.toString(), "", "0x0000000000000000000000000000000000000000000000000000000000000000", tag],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    if (!tx.data?.id) throw new Error("Circle transaction returned no ID.");
    const txHash = await waitForTx(circleClient, tx.data.id);
    const updated = await recordValidationResponse(jobIdBigInt, txHash, passed, tag);
    return NextResponse.json({ success: true, jobId, requestHash: policy.requestHash, passed, responseCode, tag, validatorSCA, txHash, explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`, status: updated.status, message: `Validation response submitted — ${passed ? "PASSED" : "FAILED"} (tag: ${tag})` });
  };
  return withApiKeyOrAnySession(handler as any)(req);
}
