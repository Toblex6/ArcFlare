// POST /api/procurement/[id]/apply — apply to a procurement posting
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });
  if (posting.status !== "OPEN") return NextResponse.json({ error: `posting is ${posting.status}, not OPEN` }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const { applicantAddress, pitch, proposedAmount, portfolioLinks } = body;
  if (!applicantAddress || !pitch) return NextResponse.json({ error: "applicantAddress and pitch are required" }, { status: 400 });
  if (!/^0x[a-fA-F0-9]{40}$/.test(applicantAddress)) return NextResponse.json({ error: "invalid applicantAddress" }, { status: 400 });

  const actor = await verifyCallerControlsAddress(req, applicantAddress);
  if (!actor) return NextResponse.json({ error: "You do not control the claimed applicant address." }, { status: 403 });

  let proposedUnits: string | null = null;
  if (proposedAmount !== undefined && proposedAmount !== null && proposedAmount !== "") {
    const s = String(proposedAmount).trim();
    if (/^\d+$/.test(s)) proposedUnits = s;
    else if (/^\d+(\.\d{1,6})?$/.test(s)) proposedUnits = (BigInt(Math.round(parseFloat(s) * 1_000_000))).toString();
    else return NextResponse.json({ error: "invalid proposedAmount" }, { status: 400 });
    if (BigInt(proposedUnits) > BigInt(posting.budgetMax)) return NextResponse.json({ error: "proposedAmount exceeds posting budgetMax" }, { status: 400 });
  }

  // Resolve applicantAgentId if it's an agent SCA
  let applicantAgentId: number | null = null;
  try {
    const ag = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: applicantAddress, mode: "insensitive" } }, select: { id: true } });
    if (ag) applicantAgentId = ag.id;
  } catch {}

  try {
    const app = await (prisma as any).procurementApplication.create({
      data: {
        procurementId: id,
        applicantAgentId,
        applicantAddress: applicantAddress.toLowerCase(),
        pitch: String(pitch),
        proposedAmount: proposedUnits,
        portfolioLinks: Array.isArray(portfolioLinks) ? portfolioLinks.map((l: any) => String(l)) : [],
      },
    });
    return NextResponse.json({ success: true, applicationId: app.id });
  } catch (e: any) {
    if (e?.code === "P2002") return NextResponse.json({ error: "already applied to this posting" }, { status: 409 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
