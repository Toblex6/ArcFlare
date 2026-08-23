// src/app/api/agents/[id]/card/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
    supportedChains: ["ARC-TESTNET"],
    supportedTokens: ["USDC", "EURC"],
    hiring: { hireEndpoint: `/api/agents/${agent.id}/hire`, createJobEndpoint: `/api/agents/${agent.id}/hire`, escrowContract: process.env.AGENTIC_COMMERCE_CONTRACT || "0x0747EEf0706327138c69792bF28Cd525089e4583", jobTypes: ["escrow"] },
    validation: { registryAddress: process.env.VALIDATION_REGISTRY_ADDRESS || "0x8004Cb1BF31DAf7788923b405b754f57acEB4272", verifyEndpoint: `/api/agent/validation?agentId=${agent.tokenId}` },
    generatedAt: new Date().toISOString(),
    schemaVersion: "1.0",
  };
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  if (agent.status !== "ACTIVE_AGENT_PROVISIONED") return NextResponse.json({ error: "Agent not available for discovery" }, { status: 404 });
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE || req.nextUrl.origin;
  const card = buildAgentCard(agent, baseUrl);
  return NextResponse.json({ success: true, agentCard: card });
}
