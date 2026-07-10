import { NextRequest, NextResponse } from "next/server";
import { withGateway } from "@/lib/x402";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, keccak256, toHex } from "viem";

// ── ERC-8004 Registry addresses (confirmed from Arc docs) ─────────────────────
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(txId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await getCircleClient().getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === "FAILED") throw new Error("Reputation tx failed");
  }
  throw new Error("Reputation tx timed out");
}

// ── Record ERC-8004 reputation after successful job ───────────────────────────
async function recordJobReputation(
  agentId: string,
  validatorWalletId: string,
  validatorWalletAddress: string,
  tag: string,
  score: number
) {
  try {
    const circleClient = getCircleClient();
    const feedbackHash = keccak256(toHex(tag));

    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress: validatorWalletAddress,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: REPUTATION_REGISTRY,
      abiFunctionSignature:
        "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      abiParameters: [
        agentId,
        score.toString(),
        "0",
        tag,
        "",
        "",
        "",
        feedbackHash,
      ],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    if (tx.data?.id) {
      // Non-blocking — don't delay the response
      waitForCircleTx(tx.data.id)
        .then((hash) => console.log(`[agent] Reputation recorded: ${hash}`))
        .catch((e) => console.error("[agent] Reputation failed:", e.message));
    }
  } catch (e: any) {
    console.error("[agent] Reputation error:", e.message);
  }
}

// ── Call Claude API to perform the actual agent task ─────────────────────────
async function runAgentTask(task: string, context?: string): Promise<string> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const systemPrompt = `You are ArcFlare's AI payment advisor agent, registered on Arc Testnet 
with ERC-8004 identity. You help users optimize their stablecoin payment strategies, 
analyze payment flows, and make recommendations for using ArcFlare's primitives 
(checkout, escrow, streaming, nanopayments, payroll, scheduled payments).

Be concise, actionable, and specific. Always frame advice in terms of USDC on Arc.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: context
            ? `Context: ${context}\n\nTask: ${task}`
            : task,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("No response from Claude");
  return text;
}

// ── Route handler — the actual paid work ─────────────────────────────────────
const agentServiceHandler = async (req: NextRequest): Promise<NextResponse> => {
  let task = "";
  let context = "";

  try {
    const body = await req.json().catch(() => ({}));
    task = body.task || "Analyze the best payment strategy for a small business using ArcFlare";
    context = body.context || "";
  } catch {}

  if (!task) {
    return NextResponse.json(
      { success: false, error: "task field is required" },
      { status: 400 }
    );
  }

  console.log(`[agent] Running task: ${task.slice(0, 80)}...`);

  // ── Do the actual AI work ─────────────────────────────────────────────────
  const result = await runAgentTask(task, context);

  // ── Record ERC-8004 reputation (non-blocking) ─────────────────────────────
  const agentId = process.env.AGENT_TOKEN_ID;
  const validatorWalletId = process.env.AGENT_VALIDATOR_WALLET_ID;
  const validatorWalletAddress = process.env.AGENT_VALIDATOR_WALLET_ADDRESS;

  if (agentId && validatorWalletId && validatorWalletAddress) {
    recordJobReputation(
      agentId,
      validatorWalletId,
      validatorWalletAddress,
      "successful_payment_advice",
      90
    );
  } else {
    console.warn("[agent] Skipping reputation recording — agent env vars not set");
  }

  return NextResponse.json({
    success: true,
    agent: {
      id: agentId || "unregistered",
      address: process.env.AGENT_OWNER_WALLET_ADDRESS || "unknown",
      network: "Arc Testnet",
      standard: "ERC-8004",
    },
    task,
    result,
    timestamp: new Date().toISOString(),
    paidVia: "Circle Gateway Nanopayments (x402)",
  });
};

// ── Export with x402 payment protection ──────────────────────────────────────
// $0.001 per agent task — buyers need Gateway balance, same as nano/pay/agent-lookup
export const POST = withGateway(
  agentServiceHandler,
  "$0.001",
  "/api/agent/service"
);

// ── GET — describe what this agent does (free, no payment needed) ─────────────
export async function GET() {
  const agentId = process.env.AGENT_TOKEN_ID;
  const ownerAddress = process.env.AGENT_OWNER_WALLET_ADDRESS;

  let reputationScore = null;
  if (agentId) {
    try {
      const score = await publicClient.readContract({
        address: REPUTATION_REGISTRY,
        abi: [
          {
            name: "getReputation",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "tokenId", type: "uint256" }],
            outputs: [{ name: "", type: "int128" }],
          },
        ],
        functionName: "getReputation",
        args: [BigInt(agentId)],
      });
      reputationScore = Number(score);
    } catch {}
  }

  return NextResponse.json({
    agent: "ArcFlare Payment Advisor",
    description: "AI agent that analyzes payment strategies and optimizes USDC flows on Arc",
    standard: "ERC-8004",
    agentId: agentId || "not registered — run scripts/agent/setup.ts first",
    ownerAddress: ownerAddress || "not set",
    reputationScore,
    reputationRegistry: REPUTATION_REGISTRY,
    explorerUrl: ownerAddress
      ? `https://testnet.arcscan.app/address/${ownerAddress}`
      : null,
    pricing: {
      perRequest: "$0.001 USDC",
      paymentProtocol: "x402 + Circle Gateway Nanopayments",
    },
    usage: {
      endpoint: "POST /api/agent/service",
      headers: { "payment-signature": "<base64-encoded x402 payment>" },
      body: { task: "string", context: "string (optional)" },
    },
    availableTasks: [
      "Analyze payment strategy for a business",
      "Compare escrow vs streaming for a specific use case",
      "Optimize payroll batching",
      "Recommend payment primitives for a given scenario",
    ],
  });
}