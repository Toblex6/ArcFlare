import { NextRequest, NextResponse } from "next/server";
import { getNetworkConfig } from "@/lib/config/network";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("payment-signature");
  console.log("Received signature:", sig);
  // Network + asset + facilitator flow from the authoritative network config
  // (were hardcoded testnet values).
  const net = getNetworkConfig();
  const requirements = {
    scheme: "exact",
    network: net.x402Network,
    amount: "1000",
    asset: net.usdcAddress,
    payTo: "0x902C565bE31c146a79350387C1f77d6896814B58",
    extra: { name: "USDC", version: "2" }
  };
  if (!sig) {
    return NextResponse.json({
      error: "Payment Required",
      accepts: [requirements]
    }, { status: 402 });
  }
  // Verify manually using fetch
  const verifyRes = await fetch(`${net.gatewayUrl}/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentPayload: sig,
      paymentRequirements: requirements
    })
  });
  const data = await verifyRes.json();
  return NextResponse.json(data);
}