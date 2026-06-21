// src/app/api/nano/pay/[endpoint]/route.ts
// FULL version — extends the earlier template with the job-status resource
// referenced in the Circle CLI skill, and pulls real data instead of stubs.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGatewayPayment, GatewayPaymentContext } from "@/lib/gateway-middleware";

const SELLER_WALLET_ADDRESS = process.env.SELLER_WALLET_ADDRESS!;

// Price table per resource — must match the prices documented in the
// pay-arcflare-service Circle CLI skill (docs/circle-skills/pay-arcflare-service.md)
const PRICE_TABLE: Record<string, string> = {
  "agent-lookup": "0.001",
  "reputation-check": "0.0005",
  "job-status": "0.0001",
};

async function handlePaidResource(
  req: NextRequest,
  payment: GatewayPaymentContext,
  endpoint: string
): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);

  const paidMeta = {
    amount: payment.amount,
    payer: payment.payer,
    network: payment.network,
    transaction: payment.transaction,
  };

  // ── agent-lookup ────────────────────────────────────────────────────────────
  if (endpoint === "agent-lookup") {
    const scaAddress = searchParams.get("scaAddress");
    if (!scaAddress) {
      return NextResponse.json({ success: false, error: "scaAddress query param required." }, { status: 400 });
    }

    const agent = await (prisma as any).agentRegistry.findUnique({ where: { scaAddress } });

    return NextResponse.json({
      success: true,
      resource: "agent-lookup",
      agent: agent
        ? { name: agent.name, tokenId: agent.tokenId, scaAddress: agent.scaAddress, status: agent.status }
        : null,
      found: !!agent,
      paid: paidMeta,
    });
  }

  // ── reputation-check ─────────────────────────────────────────────────────────
  if (endpoint === "reputation-check") {
    const agentId = searchParams.get("agentId");
    if (!agentId) {
      return NextResponse.json({ success: false, error: "agentId query param required." }, { status: 400 });
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
      paid: paidMeta,
    });
  }

  // ── job-status ────────────────────────────────────────────────────────────────
  if (endpoint === "job-status") {
    const jobId = searchParams.get("jobId");
    if (!jobId) {
      return NextResponse.json({ success: false, error: "jobId query param required." }, { status: 400 });
    }

    // Reuses the same ERC-8183 contract read pattern as /api/jobs GET
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
      paid: paidMeta,
    });
  }

  return NextResponse.json({ success: false, error: `Unknown resource: ${endpoint}` }, { status: 404 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { endpoint: string } }
) {
  const endpoint = params.endpoint;
  const priceUSDC = PRICE_TABLE[endpoint];

  if (!priceUSDC) {
    return NextResponse.json({ error: `Unknown paid resource: ${endpoint}` }, { status: 404 });
  }

  const wrapped = requireGatewayPayment(
    { sellerAddress: SELLER_WALLET_ADDRESS, priceUSDC },
    (req, payment) => handlePaidResource(req, payment, endpoint)
  );

  return wrapped(req);
}