// src/app/api/agent/brain/route.ts
// FlareHQ Autonomous Agent Brain — COMPLETE VERSION (Groq-powered)
//
// Capabilities for AGENTS specifically (separate from merchant/consumer flows):
//   1. A2A Payments          → agent pays another agent directly
//   2. Agent Escrow          → ERC-8183 job lifecycle (create/fund/submit/complete)
//   3. Agent Payroll         → agent autonomously pays a team of sub-agents
//   4. Agent Subscriptions   → agent sets up recurring payments to services
//   5. Invoice Generation    → agent generates payment requests for work done
//   6. Cross-chain Routing   → agent moves USDC across chains via CCTP V2
//   7. Hire another Agent    → ERC-8183 job with onchain escrow + evaluation
//   8. Real-world API calls  → agent fetches external data autonomously
//   9. ERC-8004 Reputation   → agent records reputation after job completion
//  10. Memory                → agent remembers context across calls
//
// Protected by x402 — $0.002 per brain call

import { NextRequest, NextResponse } from "next/server";
import { withGateway } from "@/lib/x402";
import { prisma } from "@/lib/prisma";
import { createPublicClient, http, keccak256, toHex } from "viem";
import {
  getCircleClient,
  waitForTransaction,
} from "@/lib/circle/client"; // FIX #2: reuse shared Circle client instead of a second local copy

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "https://flarehq.xyz";
const INTERNAL_API_KEY = process.env.INTERNAL_SETTLEMENT_API_KEY!;
const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

// ERC-8004 registries
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

// ERC-8183 AgenticCommerce contract on Arc Testnet
const AGENTIC_COMMERCE = "0x0747EEf0706327138c69792bF28Cd525089e4583";
const USDC_ARC = "0x3600000000000000000000000000000000000000";

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

// ── TOOL DEFINITIONS (what the agent brain can do) ────────────────────────────
const AGENT_TOOLS = [
  {
    name: "agent_pay_agent",
    description:
      "Agent A pays Agent B directly for a service. Use for immediate, synchronous payments between agents. This is A2A payment via FlareHQ M2M settlement.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "string", description: "Amount in USDC" },
        receiverAgentSCA: { type: "string", description: "Receiver agent SCA address" },
        description: { type: "string", description: "What this payment is for" },
      },
      required: ["amount", "receiverAgentSCA"],
    },
  },
  {
    name: "create_agent_job",
    description:
      "Create an ERC-8183 job to hire another agent for async work with onchain escrow. Use when work takes time and needs verification before payment. Client creates job → funds escrow → provider submits work → evaluator releases payment.",
    input_schema: {
      type: "object",
      properties: {
        providerSCA: { type: "string", description: "Agent being hired" },
        evaluatorSCA: { type: "string", description: "Who judges the work (can be same as client)" },
        amountUSDC: { type: "string" },
        description: { type: "string", description: "What the hired agent must deliver" },
        deadlineHours: { type: "number" },
      },
      required: ["providerSCA", "amountUSDC", "description"],
    },
  },
  {
    name: "submit_job_deliverable",
    description:
      "Provider agent submits completed work for an ERC-8183 job. Include the deliverable description/hash.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        providerSCA: { type: "string" },
        deliverable: { type: "string", description: "Description or hash of delivered work" },
      },
      required: ["jobId", "providerSCA", "deliverable"],
    },
  },
  {
    name: "complete_or_reject_job",
    description:
      "Evaluator agent marks a submitted ERC-8183 job as completed (releases payment) or rejected (refunds client).",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        verdict: { type: "string", enum: ["complete", "reject"] },
        reason: { type: "string" },
      },
      required: ["jobId", "verdict"],
    },
  },
  {
    name: "run_agent_payroll",
    description:
      "Agent autonomously pays a team of sub-agents or workers in one batch. Use when an orchestrator agent needs to pay multiple agents for completed work.",
    input_schema: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              recipientSCA: { type: "string" },
              amount: { type: "string" },
              label: { type: "string", description: "Agent name or ID" },
            },
          },
        },
      },
      required: ["recipients"],
    },
  },
  {
    name: "setup_agent_subscription",
    description:
      "Agent sets up a recurring automatic payment to a service or another agent. Use for ongoing subscriptions, regular data feed purchases, or periodic agent hiring.",
    input_schema: {
      type: "object",
      properties: {
        serviceAgentSCA: { type: "string", description: "Agent/service being subscribed to" },
        amountUSDC: { type: "string" },
        intervalDays: { type: "number", description: "1=daily, 7=weekly, 30=monthly" },
        description: { type: "string" },
        maxRuns: { type: "number", description: "Leave empty for indefinite" },
      },
      required: ["serviceAgentSCA", "amountUSDC", "intervalDays"],
    },
  },
  {
    name: "generate_agent_invoice",
    description:
      "Agent generates an invoice/payment request for work it has completed. Returns a payment link the client can use to pay.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "string" },
        description: { type: "string", description: "What was delivered" },
        clientIdentifier: { type: "string", description: "Client name, address, or ID" },
      },
      required: ["amount", "description"],
    },
  },
  {
    name: "route_cross_chain",
    description:
      "Agent routes USDC across chains via Circle CCTP V2. Use when an agent needs to receive or send payment on a different chain.",
    input_schema: {
      type: "object",
      properties: {
        destinationAddress: { type: "string" },
        amount: { type: "string" },
        sourceChain: { type: "string" },
        destinationChain: { type: "string", description: "e.g. ETH-SEPOLIA, ARB-SEPOLIA" },
      },
      required: ["destinationAddress", "amount", "destinationChain"],
    },
  },
  {
    name: "record_agent_reputation",
    description:
      "Record reputation feedback for an agent on ERC-8004 after a job is completed. Always call this after completing or rejecting a job to build the agent's onchain reputation trail.",
    input_schema: {
      type: "object",
      properties: {
        agentTokenId: { type: "string" },
        score: { type: "number", description: "0-100 reputation score" },
        tag: { type: "string", description: "e.g. successful_delivery, late_delivery, rejected_work" },
      },
      required: ["agentTokenId", "score", "tag"],
    },
  },
  {
    name: "fetch_agent_data",
    description:
      "Agent fetches real-world data from a public API for autonomous decision making. Use for price feeds, news, weather, exchange rates, or any external data source.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        purpose: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "check_agent_status",
    description:
      "Check the status of a payment, ERC-8183 job, recurring subscription, or agent reputation score.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["payment", "job", "subscription", "reputation"] },
        reference: { type: "string" },
      },
      required: ["type", "reference"],
    },
  },
];

// Groq's API is OpenAI-compatible: tools are wrapped as
// { type: "function", function: { name, description, parameters } }
const GROQ_TOOLS = AGENT_TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
}));

// ── TOOL EXECUTORS ────────────────────────────────────────────────────────────
async function executeTool(name: string, input: any, baseUrl: string): Promise<any> {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": INTERNAL_API_KEY,
  };

  switch (name) {
    // ── 1. A2A Direct Payment ─────────────────────────────────────────────────
    case "agent_pay_agent": {
      // SECURITY: the payer is ALWAYS the platform's own agent wallet.
      // input.payerAgentSCA is deliberately ignored (it was removed from
      // the tool schema) — the LLM can fill any amount/receiver, but it can
      // never name a payer, so a prompt-injected tool call can only spend
      // the platform agent's own balance, never another tenant's wallet.
      const payerAgentSCA = process.env.AGENT_OWNER_WALLET_ADDRESS;
      const initRes = await fetch(`${baseUrl}/api/payments/initialize`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: input.amount,
          currency: "USDC",
          agentSCA: payerAgentSCA,
          merchant: input.receiverAgentSCA,
        }),
      });
      const initData = await initRes.json();
      if (!initData.success) return { error: initData.error };

      const settleRes = await fetch(`${baseUrl}/api/payments/settle`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reference: initData.reference }),
      });
      const settleData = await settleRes.json();
      return {
        success: settleData.success,
        txHash: settleData.arcTxHash,
        explorerUrl: settleData.explorerUrl,
        amount: input.amount,
        from: payerAgentSCA,
        to: input.receiverAgentSCA,
      };
    }

    // ── 2. Create ERC-8183 Job ────────────────────────────────────────────────
    case "create_agent_job": {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "create",
          // Pinned server-side: the platform agent is the only client the
          // brain may act as. The LLM can no longer name another tenant's
          // agent as the payer of a job (cross-tenant agent-control fix).
          clientSCA: process.env.AGENT_OWNER_WALLET_ADDRESS,
          clientWalletId: process.env.AGENT_OWNER_WALLET_ID,
          providerSCA: input.providerSCA,
          evaluatorSCA: input.evaluatorSCA || process.env.AGENT_OWNER_WALLET_ADDRESS,
          amountUSDC: input.amountUSDC,
          description: input.description,
          deadlineHours: input.deadlineHours || 24,
        }),
      });
      return res.json();
    }

    // ── 3. Submit Job Deliverable ─────────────────────────────────────────────
    case "submit_job_deliverable": {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "submit",
          jobId: input.jobId,
          providerSCA: input.providerSCA,
          deliverable: input.deliverable,
        }),
      });
      return res.json();
    }

    // ── 4. Complete or Reject Job ─────────────────────────────────────────────
    case "complete_or_reject_job": {
      // SECURITY: the evaluator is ALWAYS the platform agent. The LLM can
      // pick a verdict/reason, but never the signing identity — /api/jobs
      // doesn't consume evaluatorSCA today, but if it ever does, this is
      // pinned before that day arrives (same fix pattern as agent_pay_agent).
      const res = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: input.verdict === "complete" ? "complete" : "reject",
          jobId: input.jobId,
          evaluatorSCA: process.env.AGENT_OWNER_WALLET_ADDRESS,
          evaluatorWalletId: process.env.AGENT_OWNER_WALLET_ID,
          reason: input.reason,
        }),
      });
      return res.json();
    }

    // ── 5. Agent Payroll ──────────────────────────────────────────────────────
    case "run_agent_payroll": {
      const res = await fetch(`${baseUrl}/api/payroll/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          payerSCA: process.env.AGENT_OWNER_WALLET_ADDRESS,
          payerWalletId: process.env.AGENT_OWNER_WALLET_ID,
          recipients: input.recipients,
        }),
      });
      return res.json();
    }

    // ── 6. Agent Subscription ─────────────────────────────────────────────────
    case "setup_agent_subscription": {
      const res = await fetch(`${baseUrl}/api/payments/scheduled`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          payerSCA: process.env.AGENT_OWNER_WALLET_ADDRESS,
          receiverSCA: input.serviceAgentSCA,
          amount: input.amountUSDC,
          intervalDays: input.intervalDays,
          description: input.description || `Agent subscription to ${input.serviceAgentSCA}`,
          maxRuns: input.maxRuns || null,
        }),
      });
      return res.json();
    }

    // ── 7. Generate Invoice ───────────────────────────────────────────────────
    case "generate_agent_invoice": {
      const res = await fetch(`${baseUrl}/api/payments/initialize`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: input.amount,
          currency: "USDC",
          merchant: `FlareHQ Agent Invoice — ${input.description}`,
          agentSCA: process.env.AGENT_OWNER_WALLET_ADDRESS,
        }),
      });
      const data = await res.json();
      return {
        success: data.success,
        invoiceReference: data.reference,
        paymentLink: data.checkoutUrl,
        amount: input.amount,
        description: input.description,
        client: input.clientIdentifier,
        message: `Invoice generated. Share this link with your client: ${data.checkoutUrl}`,
      };
    }

    // ── 8. Cross-chain Routing ────────────────────────────────────────────────
    case "route_cross_chain": {
      const res = await fetch(`${baseUrl}/api/cctp/transfer`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          senderSCA: process.env.AGENT_OWNER_WALLET_ADDRESS,
          senderWalletId: process.env.AGENT_OWNER_WALLET_ID,
          destinationAddress: input.destinationAddress,
          amount: input.amount,
          sourceChain: input.sourceChain || "ARC-TESTNET",
          destinationChain: input.destinationChain,
        }),
      });
      return res.json();
    }

    // ── 9. Record ERC-8004 Reputation ─────────────────────────────────────────
    case "record_agent_reputation": {
      // FIX #3: validatorWalletId was required but never used in the tx call.
      // Only validatorWalletAddress is actually needed here — dropped the
      // dead requirement so this no longer blocks on an unused variable.
      const circle = getCircleClient(); // FIX #2: shared client instead of local getCircle()
      const feedbackHash = keccak256(toHex(input.tag));
      const score = Math.max(0, Math.min(100, input.score));

      const validatorAddress = process.env.AGENT_VALIDATOR_WALLET_ADDRESS;

      if (!validatorAddress) {
        return { error: "Validator wallet not configured. Run setup script first." };
      }

      const tx = await circle.createContractExecutionTransaction({
        walletAddress: validatorAddress,
        blockchain: "ARC-TESTNET" as any,
        contractAddress: REPUTATION_REGISTRY,
        abiFunctionSignature:
          "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
        abiParameters: [
          input.agentTokenId,
          score.toString(),
          "0",
          input.tag,
          "",
          "",
          "",
          feedbackHash,
        ],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });

      if (!tx.data?.id) return { error: "No transaction ID returned" };
      const txHash = await waitForTransaction(tx.data.id, "Reputation feedback"); // FIX #2: shared helper

      return {
        success: true,
        txHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        agentTokenId: input.agentTokenId,
        score,
        tag: input.tag,
        message: `Reputation recorded onchain for agent #${input.agentTokenId}`,
      };
    }

    // ── 10. Fetch External Data ───────────────────────────────────────────────
    case "fetch_agent_data": {
      try {
        const res = await fetch(input.url, {
          headers: { "Accept": "application/json" },
        });
        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); }
        catch { parsed = text.slice(0, 1000); }
        return { success: true, data: parsed, url: input.url, purpose: input.purpose };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }

    // ── 11. Check Status ──────────────────────────────────────────────────────
    case "check_agent_status": {
      if (input.type === "payment") {
        const res = await fetch(
          `${baseUrl}/api/payments/verify/${input.reference}`,
          { headers }
        );
        return res.json();
      }
      if (input.type === "job") {
        const res = await fetch(
          `${baseUrl}/api/jobs?jobId=${input.reference}`,
          { headers }
        );
        return res.json();
      }
      if (input.type === "subscription") {
        const res = await fetch(
          `${baseUrl}/api/payments/scheduled?reference=${input.reference}`,
          { headers }
        );
        return res.json();
      }
      if (input.type === "reputation") {
        try {
          const score = await publicClient.readContract({
            address: REPUTATION_REGISTRY,
            abi: [{ name: "getReputation", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "int128" }] }],
            functionName: "getReputation",
            args: [BigInt(input.reference)],
          });
          return { success: true, agentTokenId: input.reference, reputationScore: Number(score) };
        } catch (e: any) {
          return { error: e.message };
        }
      }
      return { error: "Unknown status type" };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent Memory (Postgres) ───────────────────────────────────────────────────
// Stored shape is OpenAI/Groq-style chat messages:
// { role: "user"|"assistant"|"tool", content, tool_calls?, tool_call_id? }
async function getMemory(sessionId: string): Promise<any[]> {
  try {
    const rows = await (prisma as any).agentBrainMemory?.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      take: 20,
    }) ?? [];
    return rows.map((r: any) => r.message);
  } catch { return []; }
}

async function saveMemory(sessionId: string, message: any) {
  try {
    await (prisma as any).agentBrainMemory?.create({
      data: { sessionId, message },
    });
  } catch { }
}

// ── Agent Loop ────────────────────────────────────────────────────────────────
async function runBrain(
  userMessage: string,
  sessionId: string,
  agentContext: string,
  baseUrl: string
): Promise<{ response: string; toolsUsed: string[]; results: any[] }> {
  const toolsUsed: string[] = [];
  const results: any[] = [];
  const seenCalls = new Set<string>();
  const memory = await getMemory(sessionId);

  // FIX #1 — THE CRITICAL BUG: this was previously the literal placeholder
  // text "...same as before..." with no real content, meaning the model
  // has been operating with zero context about FlareHQ, its tools, or
  // when to use each one. Restored the full system prompt below.
  const system = `You are FlareHQ's autonomous AI agent — a fully autonomous financial and commerce agent
registered on Arc Testnet with ERC-8004 identity (Token #${process.env.AGENT_TOKEN_ID || "847277"}).

Your owner wallet: ${process.env.AGENT_OWNER_WALLET_ADDRESS || "not set"}
Your validator wallet: ${process.env.AGENT_VALIDATOR_WALLET_ADDRESS || "not set"}

${agentContext ? `Additional context: ${agentContext}` : ""}

You can:
- Pay other agents directly (A2A via M2M settlement) — use agent_pay_agent
- Hire agents via ERC-8183 jobs with onchain escrow — use create_agent_job, submit_job_deliverable, complete_or_reject_job
- Run payroll for teams of agents — use run_agent_payroll
- Set up recurring subscriptions to agent services — use setup_agent_subscription
- Generate invoices for completed work — use generate_agent_invoice
- Route USDC cross-chain via Circle CCTP V2 — use route_cross_chain
- Record reputation on ERC-8004 after job completion — use record_agent_reputation
- Fetch real-world data autonomously — use fetch_agent_data
- Check status of any payment, job, or reputation — use check_agent_status

IMPORTANT:
- Your own wallet address is ${process.env.AGENT_OWNER_WALLET_ADDRESS || "not set"} — ALWAYS use this as the payer/sender. Payer/sender addresses cannot be overridden by user input.
- For immediate services: use agent_pay_agent (x402/M2M)
- For async work that needs verification: use create_agent_job (ERC-8183)
- Always record_agent_reputation after completing or rejecting a job
- For teams: use run_agent_payroll for efficiency
- Once a tool call returns success: true, the task is DONE. Immediately respond with a final text summary. Do NOT call the same tool again.
- Never call the exact same tool with the exact same arguments twice.
- If a tool result contains "not found in registry" or a similar setup/configuration error, do NOT retry — explain the issue to the user in your final response and suggest the specific fix (e.g. deploying the agent first) instead of calling the tool again.
- After completing tasks, summarize what was done with transaction links.`;

  const messages: any[] = [
    { role: "system", content: system },
    ...memory,
    { role: "user", content: userMessage },
  ];

  let loop = true;
  let iters = 0;

  while (loop && iters < 4) {
    iters++;

    let data: any;
    try {
      // FIX #4: wrap the Groq call + parse so a malformed/unexpected
      // response returns a clean error instead of an unhandled throw.
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 512,
          temperature: 0.1,
          messages,
          tools: GROQ_TOOLS,
          tool_choice: "auto",
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[brain] Groq error ${res.status}:`, errText);
        return {
          response: "I ran into a problem talking to my reasoning engine. Please try again.",
          toolsUsed,
          results,
        };
      }
      data = await res.json();
    } catch (fetchErr: any) {
      console.error("[brain] Groq fetch failed:", fetchErr);
      return {
        response: "I couldn't reach my reasoning engine right now. Please try again shortly.",
        toolsUsed,
        results,
      };
    }

    const choice = data.choices?.[0];
    if (!choice) {
      console.error("[brain] Groq returned no choices:", JSON.stringify(data));
      return { response: "I didn't get a usable response back. Please try again.", toolsUsed, results };
    }

    const msg = choice.message;
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      const text = msg.content || "Done.";
      await saveMemory(sessionId, { role: "user", content: userMessage });
      await saveMemory(sessionId, { role: "assistant", content: text });
      return { response: text, toolsUsed, results };
    }

    messages.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls });

    let allDuplicates = true;

    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }

      const callKey = `${name}:${JSON.stringify(args)}`;

      if (seenCalls.has(callKey)) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: "Duplicate call blocked — this exact call already succeeded. Summarize and stop." }),
        });
        continue;
      }
      seenCalls.add(callKey);
      allDuplicates = false;

      toolsUsed.push(name);

      // FIX #5: catch tool execution errors so a thrown exception (network
      // blip, unexpected response shape, etc.) becomes a tool result the
      // model can react to and explain, instead of crashing the request.
      let result: any;
      try {
        result = await executeTool(name, args, baseUrl);
      } catch (toolErr: any) {
        console.error(`[brain] Tool ${name} threw:`, toolErr);
        result = { error: toolErr?.message || "Tool execution failed unexpectedly." };
      }

      results.push({ tool: name, result });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    if (allDuplicates) {
      loop = false;
      const lastResult = results[results.length - 1];
      return {
        response: `Task completed. ${lastResult ? JSON.stringify(lastResult.result) : ""}`,
        toolsUsed,
        results,
      };
    }
  }

  return { response: "Agent completed.", toolsUsed, results };
}

// ── Route Handler ─────────────────────────────────────────────────────────────
const brainHandler = async (req: NextRequest): Promise<NextResponse> => {
  const body = await req.json().catch(() => ({}));
  const { message, sessionId = `session_${Date.now()}`, context = "" } = body;

  if (!message) {
    return NextResponse.json({ success: false, error: "message is required" }, { status: 400 });
  }
  if (!GROQ_API_KEY) {
    return NextResponse.json({ success: false, error: "GROQ_API_KEY not configured" }, { status: 500 });
  }

  // Derived per-request from the actual incoming host, not a module-level
  // constant that could silently point at the wrong environment (was
  // defaulting to "https://flarehq.xyz" whenever NEXT_PUBLIC_API_BASE
  // wasn't set — every internal tool call, self-payments included, would
  // hit production instead of wherever this request actually landed).
  const forwardedProto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host") || "";
  const baseUrl = host ? `${forwardedProto}://${host}` : API_BASE;

  console.log(`[brain] ${sessionId}: ${message.slice(0, 80)}`);
  const { response, toolsUsed, results } = await runBrain(message, sessionId, context, baseUrl);

  return NextResponse.json({
    success: true,
    response,
    toolsUsed,
    results,
    sessionId,
    agent: {
      tokenId: process.env.AGENT_TOKEN_ID || "847277",
      address: process.env.AGENT_OWNER_WALLET_ADDRESS,
      standard: "ERC-8004",
      network: "Arc Testnet",
    },
  });
};

export const POST = withGateway(brainHandler, "$0.002", "/api/agent/brain");

export async function GET() {
  return NextResponse.json({
    agent: "FlareHQ Autonomous Agent Brain",
    tokenId: process.env.AGENT_TOKEN_ID || "847277",
    capabilities: AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    protocols: ["ERC-8004", "ERC-8183", "x402", "Circle CCTP V2"],
    pricing: { perCall: "$0.002 USDC via x402" },
  });
}