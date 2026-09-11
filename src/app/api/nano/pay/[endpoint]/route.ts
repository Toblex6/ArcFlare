// src/app/api/nano/pay/[endpoint]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withGateway } from "@/lib/x402";
import { checkRateLimit } from "@/lib/ratelimit";
import { getNetworkConfig } from "@/lib/config/network";

// ERC-8183 contract address resolves from the authoritative network config.
const ERC8183_ADDRESS = getNetworkConfig().erc8183Address as `0x${string}`;

// Price table – amounts in dollars (withGateway expects "$X.XX" format)
const PRICE_TABLE: Record<string, string> = {
  "agent-lookup": "$0.001",
  "reputation-check": "$0.0005",
  "job-status": "$0.0001",
};

// ── Resource handlers ────────────────────────────────────────────────────

async function handleAgentLookup(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const scaAddress = searchParams.get("scaAddress");
  if (!scaAddress) {
    return NextResponse.json(
      { success: false, error: "scaAddress query param required." },
      { status: 400 }
    );
  }

  const agent = await (prisma as any).agentRegistry.findUnique({ where: { scaAddress } });

  return NextResponse.json({
    success: true,
    resource: "agent-lookup",
    agent: agent
      ? { name: agent.name, tokenId: agent.tokenId, scaAddress: agent.scaAddress, status: agent.status }
      : null,
    found: !!agent,
  });
}

async function handleReputationCheck(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json(
      { success: false, error: "agentId query param required." },
      { status: 400 }
    );
  }

  const agent = await (prisma as any).agentRegistry.findFirst({ where: { tokenId: agentId } });
  if (!agent) {
    return NextResponse.json({ success: false, error: `Agent ${agentId} not found.` }, { status: 404 });
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

async function handleJobStatus(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json(
      { success: false, error: "jobId query param required." },
      { status: 400 }
    );
  }

  const { createPublicClient, http, formatUnits } = await import("viem");
  // Canonical ERC-8183 AgenticCommerce pin (network-aware via
  // @/lib/contracts/erc8183; no per-route literal re-declaration).
  const JOB_STATUS_NAMES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

  const arcTestnet = {
    id: getNetworkConfig().chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [getNetworkConfig().primaryRpc] }, public: { http: [getNetworkConfig().primaryRpc] } },
  } as const;

  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(getNetworkConfig().primaryRpc) });

  const jobData = await publicClient.readContract({
    address: ERC8183_ADDRESS,
    abi: [{
      name: "getJob", type: "function", stateMutability: "view",
      inputs: [{ name: "jobId", type: "uint256" }],
      outputs: [{
        type: "tuple", components: [
          { name: "id", type: "uint256" }, { name: "client", type: "address" },
          { name: "provider", type: "address" }, { name: "evaluator", type: "address" },
          { name: "description", type: "string" }, { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ]
      }],
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

const RESOURCE_HANDLERS: Record<string, (req: NextRequest) => Promise<NextResponse>> = {
  "agent-lookup": handleAgentLookup,
  "reputation-check": handleReputationCheck,
  "job-status": handleJobStatus,
};

// ── Dynamic route ──────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ endpoint: string }> }
) {
  const { endpoint } = await params;
  const { allowed, response: limitResponse } = await checkRateLimit(req, "payments");
  if (!allowed) return limitResponse;
  const price = PRICE_TABLE[endpoint];
  const resourceHandler = RESOURCE_HANDLERS[endpoint];

  if (!price || !resourceHandler) {
    return NextResponse.json(
      { success: false, error: `Unknown paid resource: ${endpoint}` },
      { status: 404 }
    );
  }

  const protectedHandler = withGateway(
    resourceHandler,
    price,
    `/api/nano/pay/${endpoint}`
  );

  return protectedHandler(req);
}