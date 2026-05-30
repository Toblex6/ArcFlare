// src/app/api/payments/initialize/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Public Endpoint: Allows any sandbox user to initiate a checkout session
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { amount, currency, email, merchant } = body;

    // Validate incoming sandbox request payload
    if (!amount || !currency || !email) {
      return NextResponse.json(
        { success: false, error: "Missing required attributes (amount, currency, email)." },
        { status: 400 }
      );
    }

    // Generate a unique transaction reference trace token
    const transactionReference = `arc_ref_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

    // Create a pending transaction ledger record inside Prisma 
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
      console.warn("Non-blocking database log warning:", e.message);
    });

    // Return the authorization URL context back to the frontend
    return NextResponse.json({
      success: true,
      message: "Ledger checkout context initialization successful.",
      reference: transactionReference,
      data: {
        reference: transactionReference,
        amount: amount,
        currency: currency,
        status: "ready",
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

// Support a basic health check check on GET
export async function GET() {
  return NextResponse.json({ success: true, status: "operational" });
}