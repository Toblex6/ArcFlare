// POST /api/procurement — create an open procurement posting (pre-chain)
// GET /api/procurement — list open postings
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";

function toUnits(v: any): string {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return s;
  if (/^\d+(\.\d{1,6})?$/.test(s)) return (BigInt(Math.round(parseFloat(s) * 1_000_000))).toString();
  throw new Error(`invalid amount ${v}`);
}

async function postHandler(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { clientAgentId, description, title, requirements, budgetMax, budgetMin, skill, category } = body;
  const cId = Number(clientAgentId);
  if (!cId || !description || budgetMax === undefined) {
    return NextResponse.json({ error: "clientAgentId, description, budgetMax are required" }, { status: 400 });
  }
  let budgetMaxUnits: string;
  try { budgetMaxUnits = toUnits(budgetMax); } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  if (BigInt(budgetMaxUnits) <= 0n) return NextResponse.json({ error: "budgetMax must be > 0" }, { status: 400 });
  let budgetMinUnits: string | null = null;
  if (budgetMin !== undefined && budgetMin !== null && budgetMin !== "") {
    try { budgetMinUnits = toUnits(budgetMin); } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  }
  if (requirements && !Array.isArray(requirements)) return NextResponse.json({ error: "requirements must be array" }, { status: 400 });
  if (requirements && requirements.length > 50) return NextResponse.json({ error: "too many requirements max 50" }, { status: 400 });

  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: cId } });
  if (!agent) return NextResponse.json({ error: "client agent not found" }, { status: 404 });
  if (agent.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "client agent not provisioned" }, { status: 400 });

  const actor = await verifyCallerControlsAddress(req, agent.scaAddress);
  if (!actor) return NextResponse.json({ error: "You do not control the client agent." }, { status: 403 });

  const posting = await (prisma as any).procurementPosting.create({
    data: {
      clientAgentId: cId,
      clientSCA: agent.scaAddress,
      title: title ? String(title) : null,
      description: String(description),
      requirements: requirements ? requirements.map((r: any) => String(r)) : null,
      budgetMax: budgetMaxUnits,
      budgetMin: budgetMinUnits,
      skill: skill ? String(skill) : null,
      category: category ? String(category) : null,
      status: "OPEN",
      merchantId: (actor as any).id ?? null,
    },
  });
  return NextResponse.json({ success: true, posting });
}

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "OPEN";
  const skill = searchParams.get("skill");
  const limit = Math.min(Number(searchParams.get("limit") || "20"), 100);
  const where: any = {};
  if (status) where.status = status;
  if (skill) where.skill = { equals: skill, mode: "insensitive" };
  const postings = await (prisma as any).procurementPosting.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { applications: false },
  });
  return NextResponse.json({ success: true, postings });
}

export async function POST(req: NextRequest) {
  return withApiKeyOrAnySession(postHandler as any)(req);
}
export async function GET(req: NextRequest) {
  return getHandler(req);
}
