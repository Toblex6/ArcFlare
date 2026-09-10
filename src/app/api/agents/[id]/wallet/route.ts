// src/app/api/agents/[id]/wallet/route.ts
//
// Agent payment wallet: returns the agent's auto-provisioned x402 payment
// EOA (get-or-create). The private key is encrypted at rest and NEVER leaves
// the server — the address only is safe to return. Same pattern as
// /api/x402/eoa-wallet/me (per-agent keying added in the agent-payments
// batch).

import { NextRequest, NextResponse } from "next/server";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { getAgentWalletAddress, getOrCreateAgentWallet } from "@/lib/x402-wallet";
import { resolveAgentRouteRef } from "@/lib/agents/resolveAgentRef";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";

async function walletHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Canonical agent reference: registry id, ERC-8004 tokenId, or SCA address
  // (auto, ambiguity refused). Caller-control + step-up below operate on the
  // RESOLVED agent — unchanged. Legacy status contract preserved: garbage
  // references → 400 "invalid agent id", well-formed but unknown → 404.
  const { agent, ambiguous, malformed } = await resolveAgentRouteRef(id);
  if (ambiguous) {
    return NextResponse.json({ error: "ambiguous agent reference" }, { status: 400 });
  }
  if (malformed) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }
  if (!agent) {
    return NextResponse.json({ error: `agent ${id} not found` }, { status: 404 });
  }
  const agentId = agent.id;

  // F4: authorization + step-up BEFORE provisioning. The SCA is the stable
  // caller-control handle, so authentication can (and must) run without
  // creating key material first. Only when a legacy row has no SCA do we
  // fall back to a READ-ONLY address lookup (never get-or-create) for the
  // control check — an unauthorized caller therefore never causes a wallet
  // row/key to be created and never learns wallet material (403 first).
  let claimAddress: string | null =
    typeof agent.scaAddress === "string" && agent.scaAddress ? agent.scaAddress : null;
  if (!claimAddress) {
    claimAddress = await getAgentWalletAddress(agentId).catch(() => null);
  }
  if (!claimAddress) {
    return NextResponse.json({ error: "This merchant account does not control this agent." }, { status: 403 });
  }
  const actor = await verifyCallerControlsAddress(req, claimAddress);
  if (!actor) {
    return NextResponse.json({ error: "This merchant account does not control this agent." }, { status: 403 });
  }

  // Consumer step-up (Stage 2): provisioning an agent payment wallet is
  // wallet/account-control — a consumer actor needs the credential.
  const walletStepUp = await requireConsumerStepUpForActor(req, actor, "consumer.wallet-bind");
  if (walletStepUp) return walletStepUp;

  // Authorized only from here: read (or idempotently create) the EOA.
  // The route stays read-only from the caller's perspective — the address
  // only is returned, the key never leaves the server.
  const wallet = await getOrCreateAgentWallet(agentId);

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