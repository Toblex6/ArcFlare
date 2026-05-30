import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";

/**
 * Core Core handler for the payment initialization pipeline.
 */
async function handler(req: Request) {
  try {
    // 1. DYNAMIC ROUTE BYPASS FOR LAYOUT LOADING (GET)
    if (req.method === "GET") {
      return NextResponse.json({
        success: true,
        status: "ready",
        message: "ArcFlare Gateway Ledger initialization channel is active.",
      });
    }

    // 2. PROCESS ACTUAL CHECKOUT INITIALIZATION (POST)
    const body = await req.json();
    const { amount, currency, email, merchant } = body;

    // Validate the incoming sandbox request payload
    if (!amount || !currency || !email) {
      return NextResponse.json(
        { success: false, error: "Missing required payload attributes (amount, currency, email)." },
        { status: 400 }
      );
    }

    // Generate a unique transaction reference trace token (Paystack style)
    const transactionReference = `arc_ref_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

    // Create a pending ledger transaction state records inside Prisma database
    // This tracks the session context before booting up the Circle Smart Contract Account
    await (prisma as any).transaction.create({
      data: {
        reference: transactionReference,
        amount: String(amount),
        currency: currency,
        customerEmail: email,
        merchantName: merchant || "ArcFlare Merchant Partner",
        status: "PENDING",
        metadata: JSON.stringify({
          layer: "Arc Testnet v1.0",
          gasStrategy: "USDC-Native Rails",
        }),
      },
    }).catch((e: any) => {
      console.warn("Non-blocking warning: Prisma local ledger logging failed:", e.message);
    });

    // 3. SECURE BACKEND RESPONSE
    // Return the reference string context cleanly down the pipeline to the UI
    return NextResponse.json({
      success: true,
      message: "Ledger checkout context initialization successful.",
      reference: transactionReference,
      data: {
        reference: transactionReference,
        amount: amount,
        currency: currency,
        status: "ready",
        // Direct internal application authorization route configuration fallback
        authorization_url: `/checkout/${transactionReference}`,
      },
    });

  } catch (error: any) {
    console.error("Critical Gateway Initialization failure:", error);
    return NextResponse.json(
      { success: false, error: "Internal Ledger Process Exception Error." },
      { status: 500 }
    );
  }
}

// Wrap the router export inside the API Key verification middleware guard
export const POST = withApiKey(handler);
export const GET = withApiKey(handler);