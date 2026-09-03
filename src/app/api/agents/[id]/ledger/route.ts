import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeTreasuryView, getRecentEntries } from "@/lib/ledger/treasuryService";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { resolveAgentRef } from "@/lib/agents/resolveAgentRef";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // User-facing reference lookup: accepts Registry ID, ERC-8004 Token or SCA
  // address (auto, ambiguity refused). Numeric registry ids remain canonical.
  const { agent, ambiguous } = await resolveAgentRef(id, "auto");
  if (ambiguous) return NextResponse.json({ error: "ambiguous agent reference" }, { status: 400 });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const agentId = agent.id;

  // Authorization: caller must control this agent (ownership model)
  try {
    const wallet = await getOrCreateAgentWallet(agentId).catch(() => null);
    const controlAddress = agent.scaAddress ?? wallet?.address ?? "";
    if (!controlAddress) return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });
    const actor = await verifyCallerControlsAddress(req, controlAddress);
    if (!actor) return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });
  } catch {
    return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });
  }
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? "20")));
  const view = await computeTreasuryView(agentId);
  const recent = await getRecentEntries(agentId, limit);
  const policy = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: agentId } }).catch(() => null);
  return NextResponse.json({
    agent: { id: agent.id, name: agent.name, scaAddress: agent.scaAddress, tokenId: agent.tokenId, status: agent.status },
    treasury: view,
    policy: policy ?? null,
    recent,
  });
}
