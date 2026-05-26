import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Circle CCTP official domain IDs for cross-chain mapping
const CCTP_DOMAINS: Record<string, number> = {
  "Ethereum": 0,
  "Avalanche": 1,
  "Arbitrum": 3,
  "Base": 6,
  "Arc": 7 // Arc-L1 network execution target domain
};

/**
 * POST Handler for Payment Initialization (Paystack-style architectural flow with CCTP support)
 * Endpoint: /api/payments/initialize
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { amount, email, metadata } = body;

    // 1. Basic validation check
    if (!amount || !email) {
      return NextResponse.json(
        { error: "Missing required fields: amount and email are mandatory." },
        { status: 400 }
      );
    }

    // 2. Generate a unique custom transaction reference trace 
    const reference = `T${Math.floor(100000 + Math.random() * 900000)}${Date.now()}`;

    // 3. Store the initial tracking state inside the PaymentLog database table
    const payment = await prisma.paymentLog.create({
      data: {
        reference: reference,
        amount: Number(amount),
        currency: metadata?.currency || "USDC",
        chain: metadata?.chain || "Arc-L1",
        senderEmail: email,
        merchant: metadata?.merchantName || "ArcFlare Gateway",
        status: "PENDING",
      },
    });

    // Determine target domain string context safely
    const sourceChain = payment.chain;

    // 4. Return deployment parameters back to the client/agent workspace with CCTP instructions
    return NextResponse.json(
      {
        status: true,
        message: "Authorization URL generated",
        data: {
          authorization_url: `https://arcflare-gateway.render.com/pay/${reference}`,
          access_code: `code_${Math.random().toString(36).substring(2, 11)}`,
          reference: payment.reference,
          // 👇 CCTP cross-chain configuration routing parameters for machine consumption
          cctp_routing: {
            source_chain: sourceChain,
            destination_chain: "Arc-L1",
            destination_domain_id: CCTP_DOMAINS["Arc"] || 7,
            token_contract_target: payment.currency,
            status: sourceChain === "Arc-L1" ? "DIRECT_SETTLEMENT" : "READY_FOR_BURN"
          }
        },
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error("❌ Initialization Layer Failure:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  }
}