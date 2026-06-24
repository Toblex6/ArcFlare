import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("payment-signature");
  console.log("Received signature:", sig);
  if (!sig) {
    return NextResponse.json({
      error: "Payment Required",
      accepts: [{
        scheme: "exact",
        network: "eip155:5042002",
        amount: "1000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0x902C565bE31c146a79350387C1f77d6896814B58",
        extra: { name: "USDC", version: "2" }
      }]
    }, { status: 402 });
  }
  // Verify manually using fetch
  const verifyRes = await fetch("https://gateway-api-testnet.circle.com/v1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentPayload: sig,
      paymentRequirements: {
        scheme: "exact",
        network: "eip155:5042002",
        amount: "1000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0x902C565bE31c146a79350387C1f77d6896814B58",
        extra: { name: "USDC", version: "2" }
      }
    })
  });
  const data = await verifyRes.json();
  return NextResponse.json(data);
}