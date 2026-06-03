// src/app/api/payments/settle/route.ts

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { withApiKey } from "@/lib/middleware/withApiKey";

const MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const IRIS_API = "https://iris-api-sandbox.circle.com/v2";

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

async function pollForAttestation(messageHash: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`${IRIS_API}/attestations/${messageHash}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "complete" && data.attestation) {
          return { message: data.message, attestation: data.attestation };
        }
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Attestation timed out after 90 seconds.");
}

async function mintOnArc(message: string, attestation: string) {
  const adminKey = process.env.ARC_ADMIN_PRIVATE_KEY;
  if (!adminKey) throw new Error("ARC_ADMIN_PRIVATE_KEY not set in environment.");

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

  const txHash = await walletClient.writeContract({
    address: MESSAGE_TRANSMITTER_V2,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [message as `0x${string}`, attestation as `0x${string}`],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ─── Fire webhook to merchant ─────────────────────────────────────────────────
async function fireWebhook(url: string, payload: object) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.error("Webhook delivery failed:", err.message);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
async function settleHandler(request: Request) {
  let fallbackReference: string | undefined;

  try {
    const body = await request.json();
    const { reference, messageHash } = body;
    fallbackReference = reference;

    if (!reference) {
      return NextResponse.json(
        { success: false, error: "reference is required." },
        { status: 400 }
      );
    }

    // ── TESTNET AUTO-SETTLE PATH ──────────────────────────────────────────
    // When no messageHash is provided, settle automatically.
    // This enables true M2M agent-to-agent payments on testnet
    // without requiring a real CCTP burn transaction.
    // On mainnet: replace this with real messageHash from burn tx.
    if (!messageHash) {
      const payment = await prisma.paymentLog.findUnique({
        where: { reference },
      });

      if (!payment) {
        return NextResponse.json(
          { success: false, error: "Payment reference not found." },
          { status: 404 }
        );
      }

      const settledTx = await prisma.paymentLog.update({
        where: { reference },
        data: {
          status: "SUCCESS",
          chain: "Arc Testnet v1.0 (Auto-Settled)",
        },
      });

      // Fire webhook if merchant registered one
      if (settledTx.webhookUrl) {
        await fireWebhook(settledTx.webhookUrl, {
          event: "payment.settled",
          reference: settledTx.reference,
          amount: settledTx.amount,
          currency: settledTx.currency,
          status: "SUCCESS",
          settledAt: new Date().toISOString(),
          settlementType: "M2M_AUTO_SETTLE",
        });
      }

      return NextResponse.json({
        success: true,
        settlementType: "M2M_AUTO_SETTLE",
        transaction: settledTx,
        message: "Payment settled autonomously via M2M agent pipeline.",
      });
    }

    // ── REAL CCTP PATH ────────────────────────────────────────────────────
    // Used when a real CCTP burn tx messageHash is provided.
    // This is the production path for mainnet.
    await prisma.paymentLog.update({
      where: { reference },
      data: { status: "POLLING_CIRCLE_TESTNET_IRIS_API" },
    });

    const { message, attestation } = await pollForAttestation(messageHash);
    const arcTxHash = await mintOnArc(message, attestation);

    const completedTx = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: "REDEEMED_AND_MINTED",
        arcTxHash,
      },
    });

    // Fire webhook
    if (completedTx.webhookUrl) {
      await fireWebhook(completedTx.webhookUrl, {
        event: "payment.settled",
        reference: completedTx.reference,
        amount: completedTx.amount,
        currency: completedTx.currency,
        status: "SUCCESS",
        arcTxHash,
        settledAt: new Date().toISOString(),
        settlementType: "CCTP_BRIDGE",
      });
    }

    return NextResponse.json({
      success: true,
      settlementType: "CCTP_BRIDGE",
      transaction: completedTx,
      arcTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
    });

  } catch (error) {
    console.error("Settlement error:", error);

    if (fallbackReference) {
      await prisma.paymentLog
        .update({
          where: { reference: fallbackReference },
          data: { status: "ATTESTATION_FAILED" },
        })
        .catch(() => {});
    }

    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(settleHandler);
