// src/app/api/payments/initialize/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { amount, currency, email, merchant, agentSCA, webhookUrl } = body;

    if (!amount || !currency) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: amount, currency." },
        { status: 400 }
      );
    }

    const transactionReference = `arc_ref_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

    await prisma.paymentLog.create({
      data: {
        reference: transactionReference,
        amount: Number(amount),
        currency: currency,
        chain: "Arc Testnet v1.0",
        senderEmail: email || agentSCA || "autonomous-agent@arc.network",
        merchant: merchant || "Dispatch Marketplace",
        status: "PENDING",
        webhookUrl: webhookUrl || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Payment initialized successfully.",
      reference: transactionReference,
      checkoutUrl: `https://arcflare-gateway.onrender.com/checkout/${transactionReference}`,
      data: {
        reference: transactionReference,
        amount,
        currency,
        status: "ready",
        authorization_url: `/checkout/${transactionReference}`,
      },
    });
  } catch (error: any) {
    console.error("Initialize error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Ledger Process Exception Error." },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: "ready",
    message: "ArcFlare Gateway Ledger initialization channel is active.",
  });
}
