// FlareHQ Jobs board. This is FlareHQEscrow-backed and NOT ERC-8183.
// Every request gates on a configured escrow first: Arc mainnet returns 503
// until ARC_MAINNET_ESCROW_ADDRESS is set to the verified deployment.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { checkEscrowAmount } from "@/lib/escrow/escrowAmount";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { parseJobUnits, serializeFlareHQJob } from "@/lib/jobs/flarehqJob";

export async function POST(req: NextRequest) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;

  const body = await req.json().catch(() => ({}));
  const auth = await requireFlareHQJobActor(req, body.clientAddress);
  if (!auth) {
    return NextResponse.json({ success: false, error: "You do not control clientAddress." }, { status: 403 });
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > 10_000) {
    return NextResponse.json({ success: false, error: "description is required and must be at most 10,000 characters." }, { status: 400 });
  }
  let budget: bigint;
  try { budget = parseJobUnits(body.budget); }
  catch (e: any) { return NextResponse.json({ success: false, error: e.message }, { status: 400 }); }
  const checked = checkEscrowAmount(budget);
  if ("error" in checked) return NextResponse.json({ success: false, error: checked.error }, { status: checked.status });
  const requirements = body.requirements === undefined ? null : body.requirements;
  if (requirements !== null && (!Array.isArray(requirements) || requirements.length > 50 || requirements.some((r: unknown) => typeof r !== "string" || r.length > 1000))) {
    return NextResponse.json({ success: false, error: "requirements must be an array of at most 50 strings." }, { status: 400 });
  }
  const job = await (prisma as any).flareHQJob.create({
    data: {
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null,
      description,
      requirements,
      budget: budget.toString(),
      clientAddress: auth.address.toLowerCase(),
      clientActorType: auth.actor.type,
      clientActorId: auth.actor.id,
      status: "OPEN",
    },
  });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(job) }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "OPEN";
  const mine = url.searchParams.get("address");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const where: any = {};
  if (status !== "all") where.status = status;
  if (mine) {
    const auth = await requireFlareHQJobActor(req, mine);
    if (!auth) return NextResponse.json({ success: false, error: "You do not control address." }, { status: 403 });
    where.OR = [
      { clientAddress: { equals: auth.address, mode: "insensitive" } },
      { providerAddress: { equals: auth.address, mode: "insensitive" } },
    ];
  }
  const jobs = await (prisma as any).flareHQJob.findMany({
    where,
    include: { applications: false },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ success: true, product: "FlareHQ Jobs", protocol: "FlareHQEscrow", jobs: jobs.map(serializeFlareHQJob) });
}
