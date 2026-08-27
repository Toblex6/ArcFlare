import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { computeTreasuryView } from "@/lib/ledger/treasuryService";
import { getOrCreatePolicy, upsertPolicy } from "@/lib/ledger/treasuryPolicy";

async function getHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
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
    const policy = await upsertPolicy(agentId, {
      reserveMinimum: body.reserveMinimum !== undefined ? toUnits(body.reserveMinimum) : undefined,
      maxSpendPerJob: body.maxSpendPerJob !== undefined ? toUnits(body.maxSpendPerJob) : undefined,
      maxSpendPerDay: body.maxSpendPerDay !== undefined ? toUnits(body.maxSpendPerDay) : undefined,
      maxSubcontractorSpendPerDay: body.maxSubcontractorSpendPerDay !== undefined ? toUnits(body.maxSubcontractorSpendPerDay) : undefined,
      autoPaySubcontractors: body.autoPaySubcontractors,
      reinvestPercent: body.reinvestPercent,
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
