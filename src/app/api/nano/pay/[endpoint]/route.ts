// src/app/api/nano/pay/[endpoint]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withGateway } from "@/lib/x402";
import { prisma } from "@/lib/prisma";

// Price table per resource
const PRICE_TABLE: Record<string, string> = {
  "agent-lookup": "$0.001",
  "reputation-check": "$0.0005",
  "job-status": "$0.0001",
};

async function handlePaidResource(req: NextRequest, endpoint: string): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);

  // ── agent-lookup ────────────────────────────────────────────────────────────
  if (endpoint === "agent-lookup") {
    const scaAddress = searchParams.get("scaAddress");
    if (!scaAddress) {
      return NextResponse.json({ success: false, error: "scaAddress required" }, { status: 400 });
    }

    const agent = await prisma.agentRegistry.findUnique({ where: { scaAddress } });

    return NextResponse.json({
      success: true,
      resource: "agent-lookup",
      agent: agent
        ? { name: agent.name, tokenId: agent.tokenId, scaAddress: agent.scaAddress, status: agent.status }
        : null,
      found: !!agent,
    });
  }

  // ── reputation-check ─────────────────────────────────────────────────────────
  if (endpoint === "reputation-check") {
    const agentId = searchParams.get("agentId");
    if (!agentId) {
      return NextResponse.json({ success: false, error: "agentId required" }, { status: 400 });
    }

    const agent = await prisma.agentRegistry.findFirst({ where: { tokenId: agentId } });
    if (!agent) {
      return NextResponse.json({ success: false, error: `Agent ${agentId} not found` }, { status: 404 });
    }

    const payments = await prisma.paymentLog.findMany({ where: { senderEmail: agent.scaAddress } });
    const successCount = payments.filter((p) => p.status === "SUCCESS").length;
    const estimatedScore = payments.length > 0 ? Math.round((successCount / payments.length) * 100) : 0;

    return NextResponse.json({
      success: true,
      resource: "reputation-check",
      agentId,
      estimatedScore,
      totalPayments: payments.length,
      successfulPayments: successCount,
    });
  }

  // ── job-status ────────────────────────────────────────────────────────────────
  if (endpoint === "job-status") {
    const jobId = searchParams.get("jobId");
    if (!jobId) {
      return NextResponse.json({ success: false, error: "jobId required" }, { status: 400 });
    }

    const { createPublicClient, http, formatUnits } = await import("viem");
    const AGENTIC_COMMERCE_CONTRACT = "0x0747EEf0706327138c69792bF28Cd525089e4583";
    const JOB_STATUS_NAMES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

    const arcTestnet = {
      id: 5042002,
      name: "Arc Testnet",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] }, public: { http: ["https://rpc.testnet.arc.network"] } },
    } as const;

    const publicClient = createPublicClient({ chain: arcTestnet, transport: http("https://rpc.testnet.arc.network") });

    const jobData = await publicClient.readContract({
      address: AGENTIC_COMMERCE_CONTRACT,
      abi: [{
        name: "getJob", type: "function", stateMutability: "view",
        inputs: [{ name: "jobId", type: "uint256" }],
        outputs: [{ type: "tuple", components: [
          { name: "id", type: "uint256" }, { name: "client", type: "address" },
          { name: "provider", type: "address" }, { name: "evaluator", type: "address" },
          { name: "description", type: "string" }, { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ]}],
      }],
      functionName: "getJob",
      args: [BigInt(jobId)],
    }) as any;

    return NextResponse.json({
      success: true,
      resource: "job-status",
      job: {
        jobId,
        status: JOB_STATUS_NAMES[Number(jobData.status)] || "Unknown",
        budgetUSDC: formatUnits(jobData.budget, 6),
        client: jobData.client,
        provider: jobData.provider,
      },
    });
  }

  return NextResponse.json({ success: false, error: `Unknown resource: ${endpoint}` }, { status: 404 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ endpoint: string }> }
) {
  const { endpoint } = await params;
  const price = PRICE_TABLE[endpoint];

  if (!price) {
    return NextResponse.json({ error: `Unknown paid resource: ${endpoint}` }, { status: 404 });
  }

  // Wrap the handler with x402 payment gateway
  return withGateway(
    (req) => handlePaidResource(req, endpoint),
    price,
    `/api/nano/pay/${endpoint}`
  )(req);
}