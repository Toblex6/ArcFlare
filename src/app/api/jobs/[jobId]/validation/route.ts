import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getJobValidationStatus } from "@/lib/jobs/jobValidationPolicy";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const jobIdBigInt = BigInt(jobId);
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
      validationRegistryAddress: process.env.VALIDATION_REGISTRY_ADDRESS || process.env.NEXT_PUBLIC_VALIDATION_REGISTRY || "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    });
  } catch (e: any) {
    console.error("GET job validation status error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
