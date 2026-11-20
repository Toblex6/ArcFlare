import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { serializeFlareHQJob } from "@/lib/jobs/flarehqJob";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  const auth = await requireFlareHQJobActor(req, job.clientAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the job client can select an application." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, auth.actor, "consumer.job-fund");
  if (stepUp) return stepUp;
  if (job.status !== "OPEN") return NextResponse.json({ success: false, error: `Job is ${job.status}, not OPEN.` }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const application = await (prisma as any).flareHQJobApplication.findFirst({
    where: {
      jobId: id,
      ...(body.applicationId ? { id: body.applicationId } : { applicantAddress: { equals: String(body.providerAddress ?? ""), mode: "insensitive" } }),
    },
  });
  if (!application) return NextResponse.json({ success: false, error: "Application not found for this job." }, { status: 404 });
  const claim = await (prisma as any).flareHQJob.updateMany({
    where: { id, status: "OPEN" },
    data: {
      status: "SELECTED",
      providerAddress: application.applicantAddress,
      providerActorType: application.applicantType,
      providerActorId: application.applicantActorId,
    },
  });
  if (claim.count !== 1) return NextResponse.json({ success: false, error: "Another selection won concurrently." }, { status: 409 });
  await (prisma as any).flareHQJobApplication.updateMany({ where: { jobId: id }, data: { status: "REJECTED" } });
  await (prisma as any).flareHQJobApplication.update({ where: { id: application.id }, data: { status: "SELECTED" } });
  const updated = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(updated) });
}
