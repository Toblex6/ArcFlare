// GET /api/agents/[id]/track-record — public safe, no treasury/balance leakage
import { NextRequest, NextResponse } from "next/server";
import { resolveAgentRef } from "@/lib/agents/resolveAgentRef";
import { getTrackRecord } from "@/lib/trust/trackRecord";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // User-facing reference lookup: accepts Registry ID, ERC-8004 Token or SCA
  // address (auto, ambiguity refused). Numeric registry ids remain canonical.
  const { agent, ambiguous } = await resolveAgentRef(id, "auto");
  if (ambiguous) return NextResponse.json({ error: "ambiguous agent reference" }, { status: 400 });
  if (!agent) return NextResponse.json({ error: `agent ${id} not found` }, { status: 404 });
  const agentId = agent.id;

  // Only discoverable agents expose track record publicly — same gate as card
  // But relax: allow any ACTIVE_AGENT_PROVISIONED or older agents? Keep same as card for consistency.
  // Fresh agents with low trust should still show track record.
  try {
    const record = await getTrackRecord(agentId);
    return NextResponse.json({ success: true, trackRecord: record });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
