import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { getAgentWalletAddress, getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { computeTreasuryView } from "@/lib/ledger/treasuryService";
import { getOrCreatePolicy, upsertPolicy } from "@/lib/ledger/treasuryPolicy";

// Security cleanup batch 1: the GET handler must not have wallet-provisioning
// side effects. It previously provisioned a wallet BEFORE the caller-control
// check, so an unauthenticated GET could create wallet rows +
// encrypted key material. Authorization order now matches
// /api/agents/[id]/wallet (F4): resolve agent → read-only control address →
// verifyCallerControlsAddress → only then read. getAgentWalletAddress() is a
// pure read (SELECT address) — never creates. POST (auth-wrapped via
// withApiKeyOrAnySession) keeps its pre-existing get-or-create, which only
// ever runs for an authenticated caller.
async function getHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  // Authorization: caller must control this agent.
  // Read-only address resolution ONLY — no wallet rows are created here.
  const controlAddress =
    (typeof agent.scaAddress === "string" && agent.scaAddress) ||
    (await getAgentWalletAddress(agentId).catch(() => null)) ||
    "";
  if (!controlAddress) return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });
  const actor = await verifyCallerControlsAddress(req, controlAddress);
  if (!actor) return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });
  const view = await computeTreasuryView(agentId);
  const policy = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: agentId } }).catch(() => null);
  return NextResponse.json({ agent: { id: agent.id, name: agent.name, scaAddress: agent.scaAddress }, treasury: view, policy });
}

async function postHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const wallet = await getOrCreateAgentWallet(agentId);
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? wallet.address);
  if (!actor) return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });
  // Consumer step-up (Stage 2): treasury policy caps gate spending — a
  // consumer actor changing them needs the step-up credential.
  const treasuryStepUp = await requireConsumerStepUpForActor(req, actor, "consumer.treasury");
  if (treasuryStepUp) return treasuryStepUp;
  const body = await req.json().catch(() => ({}));
  // allow both 6-dec integer strings and decimal USDC strings for convenience
  function toUnits(v: any): string | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return s;
    if (/^\d+(\.\d{1,6})?$/.test(s)) return (BigInt(Math.round(parseFloat(s) * 1_000_000))).toString();
    throw new Error(`invalid amount ${v}`);
  }
  try {
    let minTrustScore: number | null | undefined = undefined;
    if (body.minTrustScore !== undefined) {
      if (body.minTrustScore === null || body.minTrustScore === "") minTrustScore = null;
      else {
        const v = Number(body.minTrustScore);
        if (!Number.isInteger(v) || v < 0 || v > 100) return NextResponse.json({ error: "minTrustScore must be integer 0..100 or null" }, { status: 400 });
        minTrustScore = v;
      }
    }
    const policy = await upsertPolicy(agentId, {
      reserveMinimum: body.reserveMinimum !== undefined ? toUnits(body.reserveMinimum) : undefined,
      maxSpendPerJob: body.maxSpendPerJob !== undefined ? toUnits(body.maxSpendPerJob) : undefined,
      maxSpendPerDay: body.maxSpendPerDay !== undefined ? toUnits(body.maxSpendPerDay) : undefined,
      maxSubcontractorSpendPerDay: body.maxSubcontractorSpendPerDay !== undefined ? toUnits(body.maxSubcontractorSpendPerDay) : undefined,
      autoPaySubcontractors: body.autoPaySubcontractors,
      reinvestPercent: body.reinvestPercent,
      minTrustScore,
    });
    return NextResponse.json({ success: true, policy });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return getHandler(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession((inner: NextRequest) => postHandler(inner, ctx))(req);
}
