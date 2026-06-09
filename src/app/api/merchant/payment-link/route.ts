// src/app/api/merchant/payment-link/route.ts
// Authenticated merchants create shareable payment links
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jwtVerify } from "jose";
import { checkRateLimit } from "@/lib/ratelimit";

const JWT_SECRET = new TextEncoder().encode(
  process.env.MERCHANT_JWT_SECRET || "arcflare-merchant-secret-change-on-mainnet"
);

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, "payments");
    if (!allowed) return limitResponse;

    const token = req.cookies.get("merchant_token")?.value;
    if (!token) {
      return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: "Merchant not found." }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const { amount, currency = "USDC", description, webhookUrl } = body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return NextResponse.json(
        { success: false, error: "Valid amount is required." },
        { status: 400 }
      );
    }

    const reference = `arc_ref_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

    await prisma.paymentLog.create({
      data: {
        reference,
        amount: parseFloat(amount),
        currency,
        chain: "Arc Testnet v1.0",
        senderEmail: "pending@checkout",
        merchant: merchant.businessName,
        status: "PENDING",
        webhookUrl: webhookUrl || null,
      },
    });

    const checkoutUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "https://arcflare-gateway.onrender.com"}/checkout/${reference}`;

    return NextResponse.json({
      success: true,
      reference,
      checkoutUrl,
      amount: parseFloat(amount),
      currency,
      description: description || null,
      merchant: merchant.businessName,
      expiresIn: "24 hours",
    });
  } catch (error: any) {
    console.error("Payment link error:", error);
    return NextResponse.json({ success: false, error: "Internal server error." }, { status: 500 });
  }
}

// List merchant's payment links
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get("merchant_token")?.value;
    if (!token) {
      return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;
    const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: "Merchant not found." }, { status: 404 });
    }

    const payments = await prisma.paymentLog.findMany({
      where: { merchant: merchant.businessName },
      orderBy: { timestamp: "desc" },
      take: 100,
    });

    return NextResponse.json({
      success: true,
      links: payments.map(p => ({
        reference: p.reference,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        checkoutUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "https://arcflare-gateway.onrender.com"}/checkout/${p.reference}`,
        createdAt: p.timestamp,
      })),
    });
  } catch {
    return NextResponse.json({ success: false, error: "Invalid session." }, { status: 401 });
  }
}