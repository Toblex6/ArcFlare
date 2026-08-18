// src/app/api/agents/[id]/pay/route.ts
//
// Agent-to-agent payment (roadmap: basic agent-to-agent payment execution).
// Direct on-chain settlement per docs/settlement-architecture.md boundary
// rules (Jobs-pattern flow: structured A2A with on-chain state — NOT x402;
// agent-initiated M2M purchases stay on withGateway() routes like brain/nano).
//
// Flow (src/lib/agents/agentPay.ts): resolve payer agent's payment EOA →
// caller-control check → spend-limit pre-flight → checkAndRecordSpend (cap
// enforced BEFORE the transfer — irreversible A2A, no refund possible) →
// native USDC value-send (fee-free; measured 2026-08-18) → real on-chain
// recipient credit delta verification → PaymentLog with the tx hash.

import { NextRequest, NextResponse } from "next/server";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { executeAgentToAgentPayment } from "@/lib/agents/agentPay";

async function payHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  return executeAgentToAgentPayment(req, agentId, body);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession(async (innerReq: NextRequest) => payHandler(innerReq, ctx))(req);
}