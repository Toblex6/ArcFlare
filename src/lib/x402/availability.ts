// Caller-level guard: src/lib/x402.ts / withGateway remain unchanged.
// Check before constructing a challenge/wrapper or verifying/settling payment.
import { NextResponse } from "next/server";
import { getNetworkConfig } from "@/lib/config/network";

export function x402UnavailableResponse(): NextResponse | null {
  const net = getNetworkConfig();
  if (net.name === "mainnet" && !net.x402VerifierContract) {
    return NextResponse.json(
      { success: false, error: "x402 unavailable on mainnet", code: "x402_unavailable" },
      { status: 503 }
    );
  }
  return null;
}
