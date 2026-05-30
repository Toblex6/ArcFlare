// /api/payments/settle/route.ts
// Replaces the fake setTimeout mock with real Circle CCTP attestation polling
// and Arc L1 MessageTransmitter contract call. Locked down via API Key middleware.

import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { withApiKey } from "@/lib/middleware/withApiKey";

const prisma = new PrismaClient();

// ─── Arc Testnet Contract Addresses (from docs.arc.io) ───────────────────────
const MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const ARC_DOMAIN = 26; // Arc Testnet CCTP domain

// ─── Circle Iris Sandbox API ──────────────────────────────────────────────────
const IRIS_API = "https://iris-api-sandbox.circle.com";

// ─── MessageTransmitterV2 ABI (only what we need) ────────────────────────────
const MESSAGE_TRANSMITTER_ABI = [
  {
    name: "receiveMessage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

// ─── Poll Circle Iris API until attestation is ready ─────────────────────────
async function pollForAttestation(
  messageHash: string,
  maxAttempts = 30,
  intervalMs = 3000
): Promise<{ message: string; attestation: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${IRIS_API}/attestations/${messageHash}`);

    if (res.ok) {
      const data = await res.json();
      // Iris returns { status: "complete", attestation: "0x...", message: "0x..." }
      if (data.status === "complete" && data.attestation) {
        return {
          message: data.message,
          attestation: data.attestation,
        };
      }
    }

    // Not ready yet — wait and retry
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Attestation not ready after ${maxAttempts} attempts. ` +
    `The burn tx may still be confirming on the source chain.`
  );
}

// ─── Submit attestation to Arc MessageTransmitter to mint USDC ───────────────
async function mintOnArc(message: string, attestation: string): Promise<string> {
  const adminKey = process.env.ARC_ADMIN_PRIVATE_KEY;
  if (!adminKey) throw new Error("ARC_ADMIN_PRIVATE_KEY not set in environment");

  const account = privateKeyToAccount(adminKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http("https://rpc.testnet.arc.network"),
  });

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http("https://rpc.testnet.arc.network"),
  });

  // Call receiveMessage on Arc's MessageTransmitterV2
  const txHash = await walletClient.writeContract({
    address: MESSAGE_TRANSMITTER_V2,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [message as `0x${string}`, attestation as `0x${string}`],
  });

  // Wait for Arc's sub-second finality to confirm
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return txHash;
}

// ─── Internal Route Handler Logic ─────────────────────────────────────────────
async function settleHandler(request: Request) {
  let fallbackReference: string | undefined;

  try {
    const body = await request.json();
    const { reference, messageHash } = body;
    fallbackReference = reference; // Cache reference safely for the catch block execution

    // messageHash is the keccak256 hash of the CCTP MessageSent event bytes
    if (!messageHash) {
      return NextResponse.json(
        {
          success: false,
          error:
            "messageHash is required. Pass the keccak256 hash of the " +
            "MessageSent event bytes from the source chain burn transaction.",
        },
        { status: 400 }
      );
    }

    // 1. Update status to polling state in your paymentLog table
    await prisma.paymentLog.update({
      where: { reference },
      data: { status: "POLLING_CIRCLE_TESTNET_IRIS_API" },
    });

    // 2. Poll Circle Iris API for real attestation
    const { message, attestation } = await pollForAttestation(messageHash);

    // 3. Submit attestation to Arc — this actually mints USDC on Arc L1
    const arcTxHash = await mintOnArc(message, attestation);

    // 4. Persist settlement parameters directly into your database schema
    const completedTx = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: "REDEEMED_AND_MINTED",
        arcTxHash, 
      },
    });

    return NextResponse.json({
      success: true,
      transaction: completedTx,
      arcTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
    });
  } catch (error) {
    console.error("Local settlement flow exception encountered:", error);

    // Recover database tracking state elegantly on failure routines
    if (fallbackReference) {
      await prisma.paymentLog.update({
        where: { reference: fallbackReference },
        data: { status: "ATTESTATION_FAILED" },
      }).catch(() => {}); // Catch silently to prevent nesting loops
    }

    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

// ─── Protected Export Gateway ──────────────────────────────────────────────────
// Wraps the inner handler with API key verification middleware logic
export const POST = withApiKey(settleHandler);