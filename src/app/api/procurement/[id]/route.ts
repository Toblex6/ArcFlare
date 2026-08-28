// GET /api/procurement/[id] — posting detail + ranked applicants
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRankedProcurementApplicants } from "@/lib/procurement/procurementService";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });
  let ranked: any[] = [];
  try { ranked = await getRankedProcurementApplicants(id); } catch {}
  const serialized = ranked.map((r) => ({
    ...r,
    proposedAmount: r.proposedAmount === null ? null : r.proposedAmount.toString(),
  }));
  return NextResponse.json({ success: true, posting, ranked: serialized });
}
