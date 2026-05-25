// Cache breaker: v1.0.1 - Forcing Next.js router regeneration on Render
import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

// Initialize the Prisma database client
const prisma = new PrismaClient();

/**
 * GET Handler for ArcFlare's Agentic Paywall Endpoint
 * Handles headless HTTP 402 machine-to-machine stablecoin roadblocks.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Inspect incoming headers for the transaction proof
    const paymentReference = request.headers.get("x-payment-reference");
    const agentEmail = request.headers.get("x-agent-email") || "unknown-agent@arcflare.xyz";
    const merchantName = request.headers.get("x-merchant-name") || "ArcFlare Core Engine";

    // 2. Roadblock: If no reference header is attached, send the HTTP 402 Challenge
    if (!paymentReference) {
      return NextResponse.json(
        {
          error: "Payment Required",
          amount: 0.005,
          currency: "USDC",
          settlementChain: "Arc-L1",
          paymentAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d1476B", 
          message: "Autonomous agent execution requires on-chain micro-stablecoin settlement."
        },
        { status: 402 } // Strict machine-readable roadblock
      );
    }

    // 3. Log the successful processing into your ledger using Prisma
    const transactionRecord = await prisma.paymentLog.create({
      data: {
        reference: paymentReference,
        amount: 0.005,
        currency: "USDC",
        chain: "Arc-L1",
        senderEmail: agentEmail,
        merchant: merchantName,
        status: "VERIFIED",
        timestamp: new Date(),
      },
    });

    // 4. Success: Return the payment verification metadata along with the payload
    return NextResponse.json(
      {
        status: "SUCCESS",
        unlockedAt: transactionRecord.timestamp,
        ledgerId: transactionRecord.id,
        payload: {
          dataStreamId: "ds_agent_alpha_992",
          marketTrend: "BULLISH",
          targetLiquidityDepth: "High",
          systemMessage: "Welcome behind the paywall. Data stream consumed seamlessly by agent autonomous rails."
        }
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error("❌ Paywall Runtime Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  }
}