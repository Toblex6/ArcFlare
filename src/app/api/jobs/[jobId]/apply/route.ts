import { NextRequest, NextResponse } from "next/server";
import { submitApplication } from "@/lib/jobs/applicantScoring";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";

// POST /api/jobs/[jobId]/apply
// Body: { applicantAddress, pitch, proposedAmount?, portfolioLinks? }
//
// SECURITY: the caller must prove they control `applicantAddress` using the
// same multi-party choke point the escrow/complete routes use (merchant,
// consumer, or internal-service agent). Never trusts the body address alone.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const body = await req.json().catch(() => ({}));
    const { applicantAddress, pitch, proposedAmount, portfolioLinks } = body;

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

    const application = await submitApplication({
      jobId,
      applicantAddress,
      pitch: String(pitch),
      proposedAmount: proposedAmount === undefined || proposedAmount === null || proposedAmount === "" ? undefined : BigInt(proposedAmount),
      portfolioLinks: Array.isArray(portfolioLinks) ? portfolioLinks.map((l: unknown) => String(l)) : undefined,
    });

    return NextResponse.json({
      success: true,
      applicationId: application.applicationId,
      message: "Application submitted.",
    });
  } catch (error: any) {
    // P2002 = unique constraint violation (jobId + applicantAddress) —
    // this is the race-safe duplicate detection. The pre-check in
    // submitApplication covers the common case; this catches the two
    // requests arriving simultaneously.
    const isDuplicate = error?.code === "P2002" || /already applied/i.test(error?.message || "");
    const isNotFound = /not found|invalid job id/i.test(error?.message || "");
    const status = isNotFound ? 404 : isDuplicate ? 409 : 500;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }
}