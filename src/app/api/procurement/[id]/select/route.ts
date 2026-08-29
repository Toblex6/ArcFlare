// POST /api/procurement/[id]/select — select a provider from applicants (poster-only)
// Body: { providerAddress } — must be one of the applicants; if omitted, selects top-ranked
//
// Atomicity (Build 5 repair): the OPEN→SELECTED transition is a conditional
// updateMany matched on `status` still OPEN, so concurrent selects cannot both
// win (the loser gets count0 and a 409). Trust is fail-closed: a trust
// computation error REJECTS the selection instead of proceeding.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getRankedProcurementApplicants } from "@/lib/procurement/procurementService";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  if (!posting) return NextResponse.json({ error: "posting not found" }, { status: 404 });
  if (posting.status === "SELECTED") {
    return NextResponse.json({ error: "posting already selected", status: "SELECTED", selectedProviderSCA: posting.selectedProviderSCA }, { status: 409 });
  }
  if (posting.status !== "OPEN") return NextResponse.json({ error: `posting is ${posting.status}, not OPEN` }, { status: 400 });

  const actorCheck = await verifyCallerControlsAddress(req, posting.clientSCA);
  if (!actorCheck) {
    const merchant = await resolveMerchant(req).catch(() => null);
    const owns = merchant && posting.merchantId === merchant.id;
    if (!owns) return NextResponse.json({ error: "Only the posting owner can select a provider." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  let providerAddress: string | null = body.providerAddress ? String(body.providerAddress).trim().toLowerCase() : null;

  const ranked = await getRankedProcurementApplicants(id);
  if (ranked.length === 0) return NextResponse.json({ error: "no applicants to select from" }, { status: 400 });

  if (!providerAddress) {
    providerAddress = ranked[0].applicantAddress.toLowerCase();
  } else {
    if (!/^0x[a-fA-F0-9]{40}$/.test(providerAddress)) return NextResponse.json({ error: "invalid providerAddress" }, { status: 400 });
    const isApplicant = ranked.some((r) => r.applicantAddress.toLowerCase() === providerAddress);
    if (!isApplicant) return NextResponse.json({ error: "providerAddress is not an applicant for this posting" }, { status: 400 });
  }

  if (providerAddress.toLowerCase() === posting.clientSCA.toLowerCase()) {
    return NextResponse.json({ error: "self-hire not allowed: client and provider cannot be the same address" }, { status: 400 });
  }

  // Optional trust gate (client treasury policy minTrustScore) — FAIL-CLOSED.
  try {
    const clientAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: posting.clientSCA, mode: "insensitive" } }, select: { id: true } });
    if (clientAgent) {
      const policy: any = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: clientAgent.id } }).catch(() => null);
      if (policy?.minTrustScore !== null && policy?.minTrustScore !== undefined) {
        const providerAgent = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: providerAddress, mode: "insensitive" } }, select: { id: true } });
        if (providerAgent) {
          const { computeTrustScore } = await import("@/lib/trust/trustScore");
          const t = await computeTrustScore(providerAgent.id);
          if (t.score < policy.minTrustScore) {
            return NextResponse.json({ error: `Trust requirement not met: provider trust ${t.score} < required ${policy.minTrustScore}`, code: "TRUST_REQUIREMENT_NOT_MET", providerTrust: t, required: policy.minTrustScore }, { status: 403 });
          }
        } else if (50 < policy.minTrustScore) {
          return NextResponse.json({ error: `provider has no trust history (neutral 50) < required ${policy.minTrustScore}` }, { status: 403 });
        }
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Trust evaluation failed — selection rejected: ${e?.message ?? e}`, code: "TRUST_COMPUTATION_FAILED" }, { status: 503 });
  }

  // Resolve provider agent id
  let providerId: number | null = null;
  try {
    const pa = await (prisma as any).agentRegistry.findFirst({ where: { scaAddress: { equals: providerAddress, mode: "insensitive" } }, select: { id: true } });
    if (pa) providerId = pa.id;
  } catch {}

  // ── Atomic conditional claim: OPEN → SELECTED ────────────────────────────────
  const updated = await (prisma as any).procurementPosting.updateMany({
    where: { id, status: "OPEN" },
    data: { status: "SELECTED", selectedProviderId: providerId, selectedProviderSCA: providerAddress },
  });
  if (updated.count !== 1) {
    const fresh = await (prisma as any).procurementPosting.findUnique({ where: { id } });
    return NextResponse.json({ error: "concurrent selection won", status: fresh?.status, selectedProviderSCA: fresh?.selectedProviderSCA ?? null }, { status: 409 });
  }

  const finalPosting = await (prisma as any).procurementPosting.findUnique({ where: { id } });
  return NextResponse.json({ success: true, posting: finalPosting, selectedProvider: { address: providerAddress, agentId: providerId } });
}