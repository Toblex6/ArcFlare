import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { parseJobUnits } from "@/lib/jobs/flarehqJob";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  if (job.status !== "OPEN") return NextResponse.json({ success: false, error: `Job is ${job.status}, not OPEN.` }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const auth = await requireFlareHQJobActor(req, body.applicantAddress);
  if (!auth) return NextResponse.json({ success: false, error: "You do not control applicantAddress." }, { status: 403 });
  if (auth.address.toLowerCase() === job.clientAddress.toLowerCase()) {
    return NextResponse.json({ success: false, error: "A job client cannot apply to its own job." }, { status: 400 });
  }
  const pitch = typeof body.pitch === "string" ? body.pitch.trim() : "";
  if (!pitch || pitch.length > 5000) return NextResponse.json({ success: false, error: "pitch is required and must be at most 5,000 characters." }, { status: 400 });
  let proposedAmount: string | null = null;
  if (body.proposedAmount !== undefined && body.proposedAmount !== "") {
    try { proposedAmount = parseJobUnits(body.proposedAmount).toString(); }
    catch (e: any) { return NextResponse.json({ success: false, error: e.message }, { status: 400 }); }
    if (BigInt(proposedAmount) > BigInt(job.budget)) return NextResponse.json({ success: false, error: "proposedAmount exceeds the job budget." }, { status: 400 });
  }
  try {
    const application = await (prisma as any).flareHQJobApplication.create({
      data: {
        jobId: id,
        applicantAddress: auth.address.toLowerCase(),
        applicantType: auth.actor.type,
        applicantActorId: auth.actor.id,
        pitch,
        proposedAmount,
        portfolioLinks: Array.isArray(body.portfolioLinks) ? body.portfolioLinks.slice(0, 20).map(String) : [],
      },
    });
    return NextResponse.json({ success: true, application });
  } catch (e: any) {
    if (e?.code === "P2002") return NextResponse.json({ success: false, error: "This address already applied." }, { status: 409 });
    throw e;
  }
}
