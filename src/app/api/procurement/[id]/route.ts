// GET /api/procurement/[id] — posting detail + ranked applicants
// Build 5 repair (D9): this endpoint is now OWNER-ONLY. Rival applicants' data
// and the ranked list are not public. Only the poster (client SCA holder) or
// the owning merchant may read it — same convention as the applicants endpoint.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getRankedProcurementApplicants } from "@/lib/procurement/procurementService";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });

  // Poster (client SCA) or owning merchant — nobody else may read applicant data.
  const actor = await verifyCallerControlsAddress(req, posting.clientSCA);
  if (!actor) {
    const merchant = await resolveMerchant(req).catch(() => null);
    const owns = merchant && posting.merchantId === merchant.id;
    if (!owns) return NextResponse.json({ error: "Only the posting owner can view this posting and its applications." }, { status: 403 });
  }

  let ranked: any[] = [];
  try { ranked = await getRankedProcurementApplicants(id); } catch {}
  const serialized = ranked.map((r) => ({
    ...r,
    proposedAmount: r.proposedAmount === null ? null : r.proposedAmount.toString(),
  }));
  // BigInt fields (resultingJobId) are not JSON-serializable — stringify them.
  const postingJson = {
    ...posting,
    resultingJobId: posting.resultingJobId === null || posting.resultingJobId === undefined ? null : posting.resultingJobId.toString(),
  };
  return NextResponse.json({ success: true, posting: postingJson, ranked: serialized });
}
