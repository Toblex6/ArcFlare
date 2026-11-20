import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { serializeFlareHQJob } from "@/lib/jobs/flarehqJob";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findFirst({
    where: { OR: [{ id }, ...(/^job\d+$/.test(id) ? [{ seq: Number(id.slice(3)) }] : [])] },
    include: { applications: { orderBy: { createdAt: "asc" } } },
  });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(job) });
}
