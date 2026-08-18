// src/app/api/agents/[id]/policy/route.ts
//
// Agent spending policy (roadmap: agent spending policies). Backed entirely
// by ArcFlareSpendLimit.sol (SPEND_LIMIT_CONTRACT_ADDRESS) — no rebuild, the
// existing spendLimitEnforcer + contract do the work. The contract itself is
// owner-gated; the route additionally requires the caller to control the
// agent.
//
// GET  → current cap/window/spent (on-chain view, no state change)
// POST → setLimit(capPerWindow, windowSeconds) — on-chain tx

import { NextRequest, NextResponse } from "next/server";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { getAgentPolicy, setAgentPolicy } from "@/lib/agents/agentPay";

async function policyHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }

  if (req.method === "GET") {
    return getAgentPolicy(agentId);
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    return setAgentPolicy(req, agentId, body);
  }
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession(async (innerReq: NextRequest) => policyHandler(innerReq, ctx))(req);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession(async (innerReq: NextRequest) => policyHandler(innerReq, ctx))(req);
}