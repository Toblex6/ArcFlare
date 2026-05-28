import { NextRequest, NextResponse } from "next";

// This is the "vending machine" endpoint that software interacts with
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("x-arcflare-tx-hash");
    const costInUSDC = 0.01; 

    // 1. If the machine hasn't paid yet, drop the HTTP 402 Roadblock
    if (!authHeader) {
      return new NextResponse(
        JSON.stringify({
          error: "HTTP 402 Payment Required",
          message: "Autonomous execution blocked. Stablecoin clearance required.",
          amount_due: costInUSDC,
          currency: "USDC",
          required_chain: "Arc-L1",
          // The agent reads this payload programmatically to find out where to send the funds!
          payment_gateway_address: "0xYourArcFlareEscrowAddressHere" 
        }),
        { 
          status: 402, 
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    // 2. Cryptographic Settlement Verification (Placeholder for real Arc-L1 RPC check)
    // In production, your code checks the RPC using the tx hash to make sure 0.01 USDC arrived.
    const isTxValid = true; 

    if (!isTxValid) {
      return NextResponse.json(
        { error: "Payment Verification Failed", message: "Transaction hash invalid." },
        { status: 403 }
      );
    }

    // 3. The Resource Unlock: Hand the premium data payload straight to the machine
    return NextResponse.json({
      success: true,
      cleared: true,
      tx_verified: authHeader,
      data: {
        telemetry: "⚡ Premium Machine Data Stream Payload successfully compiled for autonomous ingestion.",
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    return NextResponse.json({ error: "Internal Machine Gateway Malfunction" }, { status: 500 });
  }
}