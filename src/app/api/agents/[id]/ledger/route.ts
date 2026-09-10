import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeTreasuryView, getRecentEntries } from "@/lib/ledger/treasuryService";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getAgentWalletAddress } from "@/lib/x402-wallet";
import { resolveAgentRouteRef } from "@/lib/agents/resolveAgentRef";

// Security cleanup batch 1: GET must not have wallet-provisioning side
// effects. The previous flow provisioned a wallet BEFORE the caller-control
// check, so an unauthenticated GET could create wallet rows + encrypted key
// material (and leak the SCA fallback). The authorization order now matches
// /api/agents/[id]/wallet (F4): resolve agent → derive a
// read-only control address → verifyCallerControlsAddress → only then read.
// getAgentWalletAddress() is a pure read (SELECT address) — never creates.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // User-facing reference lookup: accepts Registry ID, ERC-8004 Token or SCA
  // address (auto, ambiguity refused). Numeric registry ids remain canonical.
  // Legacy status contract: garbage references → 400, unknown → 404.
  const { agent, ambiguous, malformed } = await resolveAgentRouteRef(id);
  if (ambiguous) return NextResponse.json({ error: "ambiguous agent reference" }, { status: 400 });
  if (malformed) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const agentId = agent.id;

  // Authorization: caller must control this agent (ownership model).
  // Read-only address resolution ONLY — no wallet rows are created here.
  try {
    const controlAddress =
      (typeof agent.scaAddress === "string" && agent.scaAddress) ||
      (await getAgentWalletAddress(agentId).catch(() => null)) ||
      "";
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
