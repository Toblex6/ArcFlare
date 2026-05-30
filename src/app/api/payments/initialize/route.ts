import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey"; // 1. Import this

const CCTP_DOMAINS: Record<string, number> = {
  "Ethereum": 0,
  "Avalanche": 1,
  "Arbitrum": 3,
  "Base": 6,
  "Arc": 7
};

// 2. Wrap your logic in a 'handler'
const handler = async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { amount, email, metadata } = body;

    if (!amount || !email) {
      return NextResponse.json(
        { error: "Missing required fields: amount and email are mandatory." },
        { status: 400 }
      );
    }

    const reference = `T${Math.floor(100000 + Math.random() * 900000)}${Date.now()}`;

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

    return NextResponse.json(
      {
        status: true,
        message: "Authorization URL generated",
        data: {
          authorization_url: `https://arcflare-gateway.render.com/pay/${reference}`,
          access_code: `code_${Math.random().toString(36).substring(2, 11)}`,
          reference: payment.reference,
          cctp_routing: {
            source_chain: payment.chain,
            destination_chain: "Arc-L1",
            destination_domain_id: CCTP_DOMAINS["Arc"] || 7,
            token_contract_target: payment.currency,
            status: payment.chain === "Arc-L1" ? "DIRECT_SETTLEMENT" : "READY_FOR_BURN"
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
};

// 3. Export the protected route
export const POST = withApiKey(handler);