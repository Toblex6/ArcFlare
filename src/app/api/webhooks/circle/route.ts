import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    console.log("=== RAW WEBHOOK BODY RECEIVED ===");
    console.log(rawBody);

    // 1. Safety Buffer: Catch empty connection pings before parsing
    if (!rawBody || rawBody.trim() === "") {
      console.log("ℹ️ Empty body validation check received.");
      return NextResponse.json({ success: true, message: "Ping accepted" });
    }

    let body: any = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.log("⚠️ Non-JSON webhook received or malformed text payload.");
      // Return 200 OK anyway so Circle doesn't flag your server as dead
      return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 200 });
    }

    console.log("=== PARSED BODY OBJECT ===");
    console.log(body);

    // 2. Normalization: Capture the event type regardless of Circle API flavor
    const eventType = body?.type || body?.notificationType;
    console.log(`🎯 Extracted Event Type: ${eventType}`);

    // 3. Handle Circle's Initial Subscription Handshake
    if (eventType === "subscription.created") {
      console.log("✅ Success: Circle subscription handshake confirmed!");
      return NextResponse.json({ success: true, message: "Handshake Complete" });
    }

    // 4. ArcFlare Gateway Ingestion Pipeline
    if (eventType === "gateway.deposit.finalized") {
      console.log("💰 [DEPOSIT FINALIZED] Processing payment confirmation...");
      // TODO: Call your Payment Verification Engine here
    }

    if (eventType === "gateway.mint.finalized") {
      console.log("🪙 [MINT FINALIZED] USDC has officially generated on the target network!");
      // TODO: Fire off webhook notification to the merchant or platform
    }

    if (eventType === "gateway.mint.forwarded") {
      console.log("🚀 [MINT FORWARDED] CCTP routing has initiated settlement forwarding.");
    }

    // Always signal 200 success back to stop Circle from retrying the event
    return NextResponse.json({ success: true });

  } catch (error) {
    console.log("🚨 CRITICAL WEBHOOK CRASH:");
    console.log(error);

    // Trap server exceptions gracefully to keep your tunnel route green
    return NextResponse.json(
      { success: false, error: "Internal processing failed safely" },
      { status: 200 } // Kept as 200 during dev to prevent lockouts during active configuration
    );
  }
}