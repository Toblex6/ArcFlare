// Provider submits deliverable metadata. No funds move here.
import { NextRequest, NextResponse } from "next/server";
import { keccak256, toBytes } from "viem";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { serializeFlareHQJob } from "@/lib/jobs/flarehqJob";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  if (!job.providerAddress) return NextResponse.json({ success: false, error: "No provider is selected." }, { status: 409 });
  const auth = await requireFlareHQJobActor(req, job.providerAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the selected provider can submit." }, { status: 403 });
  if (job.status !== "FUNDED") return NextResponse.json({ success: false, error: `Job is ${job.status}, not FUNDED.` }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const deliverable = typeof body.deliverable === "string" ? body.deliverable.trim() : "";
  if (!deliverable || deliverable.length > 50_000) return NextResponse.json({ success: false, error: "deliverable is required and must be at most 50,000 characters." }, { status: 400 });
  const updated = await (prisma as any).flareHQJob.update({
    where: { id },
    data: { status: "SUBMITTED", deliverable, deliverableHash: keccak256(toBytes(deliverable)), submittedAt: new Date() },
  });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(updated) });
}
