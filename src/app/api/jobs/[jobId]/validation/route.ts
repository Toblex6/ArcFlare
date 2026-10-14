import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getJobValidationStatus } from "@/lib/jobs/jobValidationPolicy";
import { getNetworkConfig } from "@/lib/config/network";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    // Malformed jobIds are a caller error (400), not a server error — the
    // same invalid-jobId contract as the canonical accept/fund routes.
    let jobIdBigInt: bigint;
    try {
      jobIdBigInt = BigInt(jobId);
    } catch {
      return NextResponse.json({ error: `invalid job id ${jobId}` }, { status: 400 });
    }
    const job = await prisma.erc8183Job.findUnique({ where: { jobId: jobIdBigInt } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const status = await getJobValidationStatus(jobIdBigInt);
    if (!status.policy) {
      return NextResponse.json({ success: true, jobId, validationRequired: false, message: "No validation required for this job — normal release flow applies" });
    }
    return NextResponse.json({
      success: true,
      jobId: jobId.toString(),
      validationRequired: true,
      policy: {
        validatorSCA: status.policy.validatorSCA,
        requestHash: status.policy.requestHash,
        requestTxHash: status.policy.requestTxHash,
        responseTxHash: status.policy.responseTxHash,
        status: status.policy.status,
        tag: status.policy.tag,
        required: status.policy.required,
        createdAt: status.policy.createdAt,
        updatedAt: status.policy.updatedAt,
      },
      onChain: status.onChain ? {
        validatorAddress: status.onChain.validatorAddress,
        agentId: status.onChain.agentId.toString(),
        response: status.onChain.response,
        passed: status.onChain.passed,
        pending: status.onChain.pending,
        tag: status.onChain.tag,
        lastUpdate: status.onChain.lastUpdate.toString(),
      } : null,
      evidence: status.evidence,
      // ERC-8004 ValidationRegistry from the authoritative network config —
      // the official testnet pin on testnet, the official mainnet pin on
      // mainnet. Legacy VALIDATION_/NEXT_PUBLIC_VALIDATION_REGISTRY overrides
      // are intentionally NOT honored (unset legacy var = testnet fallback).
      validationRegistryAddress: getNetworkConfig().validationRegistryAddress,
    });
  } catch (e: any) {
    console.error("GET job validation status error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
