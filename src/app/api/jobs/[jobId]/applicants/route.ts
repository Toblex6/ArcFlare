import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRankedApplicants } from "@/lib/jobs/applicantScoring";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";

// GET /api/jobs/[jobId]/applicants
// Returns the ranked applicant list for a job (best score first).
//
// SECURITY: only the poster can view. The poster is the job's client
// (evaluator = client by default in the ERC-8183 flow) or the owning
// merchant. We fail closed — no address from the request body is trusted.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;

    const job = await prisma.erc8183Job.findUnique({ where: { jobId: BigInt(jobId) } });
    if (!job) {
      return NextResponse.json({ success: false, error: `job ${jobId} not found` }, { status: 404 });
    }

    // Poster = the client SCA (evaluator defaults to client in this flow).
    const actor = await verifyCallerControlsAddress(req, job.clientSCA);
    if (!actor) {
      // Fall back to the owning merchant (dashboard/API key), if the row is scoped.
      const merchant = await resolveMerchant(req);
      const ownsJob = merchant && job.merchantId === merchant.id;
      if (!ownsJob) {
        return NextResponse.json(
          { success: false, error: "Only the job poster can view applicants." },
          { status: 403 }
        );
      }
    }

    const ranked = await getRankedApplicants(jobId);

    // BigInt can't go through JSON.stringify — expose proposedAmount as a
    // decimal string (callers wanting wei can re-parse).
    const serialized = ranked.map((r) => ({
      ...r,
      proposedAmount: r.proposedAmount === null ? null : r.proposedAmount.toString(),
    }));

    return NextResponse.json({
      success: true,
      jobId,
      ranked: serialized,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}