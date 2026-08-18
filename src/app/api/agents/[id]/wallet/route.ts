// src/app/api/agents/[id]/wallet/route.ts
//
// Agent payment wallet: returns the agent's auto-provisioned x402 payment
// EOA (get-or-create). The private key is encrypted at rest and NEVER leaves
// the server — the address only is safe to return. Same pattern as
// /api/x402/eoa-wallet/me (per-agent keying added in the agent-payments
// batch).

import { NextRequest, NextResponse } from "next/server";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { prisma } from "@/lib/prisma";

async function walletHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) {
    return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  }

  const wallet = await getOrCreateAgentWallet(agentId);
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? wallet.address);
  if (!actor) {
    return NextResponse.json({ error: "This merchant account does not control this agent." }, { status: 403 });
  }

  return NextResponse.json({
    agentId,
    address: wallet.address,
    label: "agent-payment-eoa",
    message: "Fund this EOA with USDC to let the agent pay. The key never leaves the server.",
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession(async (innerReq: NextRequest) => walletHandler(innerReq, ctx))(req);
}