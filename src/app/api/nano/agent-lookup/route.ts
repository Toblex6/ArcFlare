// src/app/api/nano/pay/agent-lookup/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireGatewayPayment, GatewayPaymentContext } from "@/lib/gateway-middleware";
import { prisma } from "@/lib/prisma";

/**
 * Core business handler: Executed ONLY after the Circle Gateway 
 * x402 middleware confirms the payment signature is verified.
 */
async function agentLookupHandler(req: NextRequest, payment: GatewayPaymentContext) {
  try {
    const { searchParams } = new URL(req.url);
    const scaAddress = searchParams.get("scaAddress");

    if (!scaAddress) {
      return NextResponse.json(
        { success: false, error: "Missing required query parameter: scaAddress" },
        { status: 400 }
      );
    }

    // Look up the agent registry information inside your local database
    const agentRecord = await prisma.agentRegistry.findFirst({
      where: { scaAddress: scaAddress },
    });

    if (!agentRecord) {
      return NextResponse.json(
        { success: false, error: "No agent matched the provided SCA address." },
        { status: 404 }
      );
    }

    // Return the protected data payload to the agent
    return NextResponse.json({
      success: true,
      x402Receipt: {
        payer: payment.payer,
        atomicUnitsPaid: payment.amount,
        network: payment.network,
      },
      agent: {
        id: agentRecord.id,
        scaAddress: agentRecord.scaAddress,
        circleWalletId: agentRecord.circleWalletId,
        createdAt: agentRecord.createdAt,
      },
    });

  } catch (error: any) {
    console.error("Agent lookup internal error:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Export and enforce the payment requirement rule on the POST method
export const POST = requireGatewayPayment(
  {
    sellerAddress: process.env.MERCHANT_SCA_ADDRESS || "0x902C565bE31c146a79350387C1f77d6896814B58",
    priceUSDC: "0.001", // This matches your CLI --max-amount cap
  },
  agentLookupHandler
);