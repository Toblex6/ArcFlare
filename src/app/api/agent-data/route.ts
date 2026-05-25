import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db"; // Fixed named import based on Turbopack trace

/**
 * GET Handler for ArcFlare's Agentic Paywall Endpoint
 * Handles headless HTTP 402 machine-to-machine stablecoin roadblocks.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Inspect incoming network headers for transaction metadata proofs
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
        { status: 402 } // Strict machine-readable roadblock status code
      );
    }

    // 3. Log the successful payment authorization into your ledger database using the named db client
    const transactionRecord = await db.paymentLog.create({
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

    // 4. Success: Return the payment confirmation alongside the premium requested payload data
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