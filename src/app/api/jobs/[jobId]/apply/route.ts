import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";

// POST /api/jobs/[jobId]/apply
// Body: { applicantAddress, pitch, proposedAmount?, portfolioLinks? }
//
// SECURITY: the caller must prove they control `applicantAddress` using the
// same multi-party choke point the escrow/complete routes use (merchant,
// consumer, or internal-service agent). Never trusts the body address alone.
//
// LEGACY DIRECT-HIRE JOBS CANNOT BE APPLIED FOR: the ERC-8183 contract fixes
// the provider at createJob time and has no provider reassignment, so a
// JobApplication row could never be acted on. This route therefore refuses
// applications outright (409) and steers to procurement postings — the flow
// that actually supports apply → select → hire. The application-scoring
// machinery (submitApplication/getRankedApplicants) remains for historical
// rows only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const body = await req.json().catch(() => ({}));
    const { applicantAddress, pitch } = body;

    if (!applicantAddress || !pitch) {
      return NextResponse.json(
        { success: false, error: "applicantAddress and pitch are required." },
        { status: 400 }
      );
    }

    const actor = await verifyCallerControlsAddress(req, applicantAddress);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: "You do not control the claimed applicant address." },
        { status: 403 }
      );
    }

    // Job must exist to distinguish "unknown job" (404) from a real
    // direct-hire job that cannot be applied for (409).
    let parsedId: bigint;
    try {
      parsedId = BigInt(jobId);
    } catch {
      return NextResponse.json({ success: false, error: `invalid job id ${jobId}` }, { status: 400 });
    }
    const job = await prisma.erc8183Job.findUnique({ where: { jobId: parsedId } });
    if (!job) {
      return NextResponse.json({ success: false, error: `job ${jobId} not found` }, { status: 404 });
    }

    return NextResponse.json(
      {
        success: false,
        error:
          `Job #${jobId} is a direct-hire job — its provider was fixed on-chain when it was created and cannot be changed, so applications are not accepted. ` +
          `Post or apply to open procurement postings instead (see /api/procurement).`,
        code: "DIRECT_HIRE_NO_APPLICATIONS",
      },
      { status: 409 }
    );
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}