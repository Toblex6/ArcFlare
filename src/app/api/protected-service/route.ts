import { NextResponse } from "next/server";

/**
 * POST /api/protected-service
 * A mock autonomous endpoint protected by the ArcFlare HTTP 402 Gateway Rails
 */
export async function POST(request: Request) {
  try {
    const headerToken = request.headers.get("X-ArcFlare-Reference");
    
    // 1. If no tracking reference header is attached, issue the native HTTP 402 challenge
    if (!headerToken) {
      return NextResponse.json(
        {
          status: false,
          error: "Payment Required",
          message: "This resource is protected by ArcFlare Agentic Paywalls.",
          payment_instructions: {
            currency: "USDC",
            amount: 0.10, // Example nanopayment / micropayment price
            chain: "Arc-L1",
            initialization_endpoint: "https://arcflare-gateway.onrender.com/api/payments/initialize"
          }
        },
        { 
          status: 402, // 👈 The magic machine-readable response code
          headers: { "WWW-Authenticate": "ArcFlare-USDC-Micropayment" }
        }
      );
    }

    // 2. Query your live validation engine to ensure the reference token state is 'SUCCESS'
    const verificationUrl = `https://arcflare-gateway.onrender.com/api/payments/verify/${headerToken}`;
    const verifyCheck = await fetch(verificationUrl);
    const verifyResult = await verifyCheck.json();

    if (!verifyResult.status || verifyResult.data.status !== "SUCCESS") {
      return NextResponse.json(
        { 
          status: false, 
          error: "Payment Unverified", 
          message: "The provided payment reference has not been settled on-chain yet.",
          verification_check_url: verificationUrl
        },
        { status: 402 }
      );
    }

    // 3. Payment is checked out and verified successfully! Release the resource to the AI Agent
    return NextResponse.json(
      {
        status: true,
        message: "Access Granted. Resource unlocked successfully.",
        data: {
          secretPayload: "Welcome to the agentic economy. This is secure data processed autonomously.",
          computedBy: "ArcFlare Gateway Engine"
        }
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error("❌ Gatekeeper Failure:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  }
}