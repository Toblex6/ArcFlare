// src/app/api/agent/reputation/route.ts
// Records reputation feedback for an agent on Arc's ERC-8004 ReputationRegistry.
// Per ERC-8004: agent owners CANNOT record reputation for their own agents.
// The validator wallet must be different from the owner wallet.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { keccak256, toHex } from "viem";

// ── ERC-8004 contracts on Arc Testnet ─────────────────────────────────────────
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string
): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === "FAILED") {
      throw new Error("Transaction failed onchain.");
    }
  }
  throw new Error("Transaction timed out.");
}

// ─── POST /api/agent/reputation ───────────────────────────────────────────────
// Records reputation feedback from a validator for an agent.
// Body: { agentId, validatorSCA, score (0-100), tag, circleWalletId }
async function reputationHandler(request: Request) {
  try {
    const {
      agentId,          // ERC-8004 tokenId e.g. "68210"
      validatorSCA,     // Validator wallet address (NOT the agent owner)
      validatorWalletId, // Circle wallet ID of validator
      score,            // 0-100 reputation score
      tag,              // e.g. "successful_payment", "completed_job"
      feedbackType,     // 0 = positive, 1 = negative, 2 = neutral
    } = await request.json();

    if (!agentId || !validatorSCA || !validatorWalletId || score === undefined || !tag) {
      return NextResponse.json(
        { success: false, error: "agentId, validatorSCA, validatorWalletId, score and tag are required." },
        { status: 400 }
      );
    }

    if (score < 0 || score > 100) {
      return NextResponse.json(
        { success: false, error: "Score must be between 0 and 100." },
        { status: 400 }
      );
    }

    // Verify agent exists in registry
    const agent = await (prisma as any).agentRegistry.findFirst({
      where: { tokenId: agentId.toString() },
    });

    if (!agent) {
      return NextResponse.json(
        { success: false, error: `Agent with tokenId ${agentId} not found in registry.` },
        { status: 404 }
      );
    }

    // Ensure validator is not the agent owner
    if (validatorSCA.toLowerCase() === agent.scaAddress.toLowerCase()) {
      return NextResponse.json(
        {
          success: false,
          error: "Per ERC-8004, agent owners cannot record reputation for their own agents.",
        },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();
    const feedbackHash = keccak256(toHex(tag)) as `0x${string}`;

    // Call giveFeedback on ReputationRegistry
    const reputationTx = await circleClient.createContractExecutionTransaction({
      walletAddress: validatorSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: REPUTATION_REGISTRY,
      abiFunctionSignature:
        "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      abiParameters: [
        agentId.toString(),
        score.toString(),
        (feedbackType || 0).toString(),
        tag,
        "",   // metadataURI — optional
        "",   // evidenceURI — optional
        "",   // comment — optional
        feedbackHash,
      ],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    if (!reputationTx.data?.id) {
      throw new Error("Circle transaction returned no ID.");
    }

    const txHash = await waitForTx(circleClient, reputationTx.data.id);

    console.log(`✅ Reputation recorded for agent ${agentId}. Score: ${score}. Tx: ${txHash}`);

    return NextResponse.json({
      success: true,
      agentId,
      agentName: agent.name,
      score,
      tag,
      feedbackHash,
      validatorSCA,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Reputation score ${score}/100 recorded for agent #${agentId} — tag: ${tag}`,
    });
  } catch (error: any) {
    console.error("❌ Reputation error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(reputationHandler);

// ─── GET /api/agent/reputation?agentId=xxx ────────────────────────────────────
// Returns reputation events for an agent from Postgres job history
async function getReputationHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");
    const scaAddress = searchParams.get("scaAddress");

    if (!agentId && !scaAddress) {
      return NextResponse.json(
        { success: false, error: "Pass agentId or scaAddress as query param." },
        { status: 400 }
      );
    }

    const where: any = {};
    if (agentId) where.tokenId = agentId;
    if (scaAddress) where.scaAddress = scaAddress;

    const agent = await (prisma as any).agentRegistry.findFirst({ where });

    if (!agent) {
      return NextResponse.json(
        { success: false, error: "Agent not found." },
        { status: 404 }
      );
    }

    // Pull payment history as proxy for reputation activity
    const payments = await prisma.paymentLog.findMany({
      where: { senderEmail: agent.scaAddress },
      orderBy: { timestamp: "desc" },
    });

    const successCount = payments.filter((p) => p.status === "SUCCESS").length;
    const totalVolume = payments
      .filter((p) => p.status === "SUCCESS")
      .reduce((sum, p) => sum + p.amount, 0);

    const estimatedScore = payments.length === 0
      ? 0
      : Math.round((successCount / payments.length) * 100);

    return NextResponse.json({
      success: true,
      agent: {
        tokenId: agent.tokenId,
        name: agent.name,
        scaAddress: agent.scaAddress,
        status: agent.status,
      },
      reputationSummary: {
        estimatedScore,
        totalPayments: payments.length,
        successfulPayments: successCount,
        totalVolumeUSDC: parseFloat(totalVolume.toFixed(6)),
        reputationRegistryAddress: REPUTATION_REGISTRY,
      },
      recentPayments: payments.slice(0, 10),
      message: `Agent #${agent.tokenId} reputation summary. For onchain reputation, check ArcScan.`,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const GET = withApiKey(getReputationHandler);
