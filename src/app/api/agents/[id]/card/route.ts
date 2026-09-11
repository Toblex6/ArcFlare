// src/app/api/agents/[id]/card/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveAgentRouteRef } from "@/lib/agents/resolveAgentRef";
import { getNetworkConfig } from "@/lib/config/network";

// Network-cutover: the ERC-8183 escrow contract address resolves from the
// authoritative network config (getNetworkConfig().erc8183Address), which is
// testnet's pinned value on testnet and the required ARC_MAINNET_ERC8183_ADDRESS
// on mainnet. The old AGENTIC_COMMERCE_CONTRACT env override is intentionally
// NOT honored — the network config is the single authority.
function resolveEscrowContract(): string {
  return getNetworkConfig().erc8183Address;
}

function buildAgentCard(agent: any, baseUrl: string) {
  return {
    agentId: agent.tokenId,
    erc8004TokenId: agent.tokenId,
    name: agent.name,
    description: agent.description || "",
    version: "1.0",
    capabilities: agent.skills ?? [],
    skills: Array.isArray(agent.skills) ? agent.skills.map((s: any) => typeof s === "string" ? { name: s, description: "" } : { name: s?.name ?? "", description: s?.description ?? "" }) : [],
    pricing: agent.pricing ?? null,
    currency: "USDC",
    wallet: { scaAddress: agent.scaAddress, circleWalletId: agent.circleWalletId, acceptedPaymentMethods: ["x402", "native_usdc", "erc20_usdc"], paymentEoaEndpoint: `/api/agents/${agent.id}/wallet` },
    endpoints: { card: `${baseUrl}/api/agents/${agent.id}/card`, reputation: `/api/agent/reputation?agentId=${agent.tokenId}`, validation: `/api/agent/validation?agentId=${agent.tokenId}`, metadataURI: agent.metadataURI },
    reputation: { score: agent.reputation ?? 50, verifyEndpoint: `/api/agent/reputation?agentId=${agent.tokenId}` },
    identity: { registryAddress: process.env.IDENTITY_REGISTRY_ADDRESS || "0x8004A818BFB912233c491871b3d84c89A494BD9e", tokenId: agent.tokenId, scaAddress: agent.scaAddress, ownerNode: agent.ownerNode, metadataURI: agent.metadataURI },
    status: agent.status,
    lastActiveAt: agent.lastActiveAt,
    createdAt: agent.createdAt,
    merchantId: agent.merchantId,
    supportedChains: [getNetworkConfig().circleBlockchain],
    supportedTokens: ["USDC", "EURC"],
    hiring: { hireEndpoint: `/api/agents/${agent.id}/hire`, createJobEndpoint: `/api/agents/${agent.id}/hire`, escrowContract: resolveEscrowContract(), jobTypes: ["escrow"] },
    validation: { registryAddress: process.env.VALIDATION_REGISTRY_ADDRESS || "0x8004Cb1BF31DAf7788923b405b754f57acEB4272", verifyEndpoint: `/api/agent/validation?agentId=${agent.tokenId}` },
    generatedAt: new Date().toISOString(),
    schemaVersion: "1.0",
  };
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Canonical agent reference: registry id, ERC-8004 tokenId, or SCA address
  // (auto, ambiguity refused). Numeric registry ids remain canonical.
  const { agent, ambiguous, malformed } = await resolveAgentRouteRef(id);
  if (ambiguous) return NextResponse.json({ error: "ambiguous agent reference" }, { status: 400 });
  if (malformed) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  if (!agent) return NextResponse.json({ error: `agent ${id} not found` }, { status: 404 });
  const agentId = agent.id;
  if (agent.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "Agent not available for discovery" }, { status: 404 });
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE || req.nextUrl.origin;
  const card: any = buildAgentCard(agent, baseUrl);
  // Build 4: attach public trust/trackRecord (best-effort, never blocks card)
  try {
    const { getTrackRecord } = await import("@/lib/trust/trackRecord");
    const tr = await getTrackRecord(agentId);
    card.trust = { score: tr.trust.score, confidence: tr.trust.confidence, methodologyVersion: tr.trust.methodologyVersion, breakdown: tr.trust.breakdown };
    card.trackRecord = { completedJobs: tr.stats.completedJobs, validatedJobs: tr.stats.validatedJobs, validationPassRate: tr.stats.validationPassRate, validatedVolume: tr.stats.validatedVolume, validatedVolumeUSDC: tr.stats.validatedVolumeUSDC, reputationCount: tr.stats.reputationCount, totalJobs: tr.stats.totalJobs, failedJobs: tr.stats.failedJobs, uniqueValidators: tr.stats.uniqueValidators, lastActivityAt: tr.stats.lastActivityAt };
    card.reputationSummary = { onChain: tr.reputation, dbReputation: tr.dbReputation };
    card.evidenceReferences = tr.evidenceReferences;
    card.trackRecordUrl = `/api/agents/${agentId}/track-record`;
  } catch {}
  return NextResponse.json({ success: true, agentCard: card });
}
