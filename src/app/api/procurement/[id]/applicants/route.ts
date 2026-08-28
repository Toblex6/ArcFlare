// GET /api/procurement/[id]/applicants — ranked list (poster-only)
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getRankedProcurementApplicants } from "@/lib/procurement/procurementService";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });

  // Poster = clientSCA or owning merchant
  const actor = await verifyCallerControlsAddress(req, posting.clientSCA);
  if (!actor) {
    const merchant = await resolveMerchant(req).catch(() => null);
    const owns = merchant && posting.merchantId === merchant.id;
    if (!owns) return NextResponse.json({ error: "Only the posting owner can view applicants." }, { status: 403 });
  }

  const ranked = await getRankedProcurementApplicants(id);
  const serialized = ranked.map((r) => ({
    ...r,
    proposedAmount: r.proposedAmount === null ? null : r.proposedAmount.toString(),
  }));
  return NextResponse.json({ success: true, procurementId: id, ranked: serialized });
}
