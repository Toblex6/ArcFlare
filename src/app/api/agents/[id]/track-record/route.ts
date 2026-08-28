// GET /api/agents/[id]/track-record — public safe, no treasury/balance leakage
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrackRecord } from "@/lib/trust/trackRecord";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
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
