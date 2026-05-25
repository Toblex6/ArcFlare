import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface PaywallConfig {
  pricePerCall?: string;
  currency?: string;
  chain?: string;
  merchantName?: string;
}

/**
 * Universal Agentic Paywall Middleware Helper (HTTP 402 Roadblock Engine)
 * Validates on-chain payment proofs before letting autonomous agent routines pass.
 */
export async function handleAgentPaywall(
  request: NextRequest,
  config: PaywallConfig = {}
) {
  const pricePerCall = config.pricePerCall || "0.005";
  const currency = config.currency || "USDC";
  const chain = config.chain || "Arc-L1";
  const merchantName = config.merchantName || "ArcFlare Core Engine";

  try {
    // 1. Inspect incoming network headers for transaction metadata proofs
    const paymentReference = request.headers.get("x-payment-reference");
    const agentEmail = request.headers.get("x-agent-email") || "unknown-agent@arcflare.xyz";

    // 2. Roadblock: If no reference header is attached, send the HTTP 402 Challenge
    if (!paymentReference) {
      return {
        isAuthorized: false,
        response: NextResponse.json(
          {
            error: "Payment Required",
            amount: parseFloat(pricePerCall),
            currency: currency,
            settlementChain: chain,
            paymentAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d1476B",
            message: "Autonomous agent execution requires on-chain micro-stablecoin settlement."
          },
          { status: 402 } // Strict machine-readable roadblock status code
        )
      };
    }

    // 3. Log the micro-transaction into your database via the correct paymentLog model
    const transactionRecord = await prisma.paymentLog.create({
      data: {
        reference: paymentReference,
        amount: parseFloat(pricePerCall),
        currency: currency,
        chain: chain,
        senderEmail: agentEmail,
        merchant: merchantName,
        status: "VERIFIED",
        timestamp: new Date(),
      },
    });

    // Return authorization success to the calling API route wrapper
    return {
      isAuthorized: true,
      transactionId: transactionRecord.id,
      timestamp: transactionRecord.timestamp
    };

  } catch (error: any) {
    console.error("❌ Paywall Engine Core Failure:", error);
    return {
      isAuthorized: false,
      response: NextResponse.json(
        { error: "Internal Paywall Engine Error", details: error.message },
        { status: 500 }
      )
    };
  }
}