// Caller-level x402 guard. src/lib/x402.ts (including withGateway) is frozen
// and remains byte-identical; every caller checks this before constructing a
// challenge, verifying, or settling.

import { NextResponse } from "next/server";
import { getNetworkConfig } from "@/lib/config/network";

export const ARC_MAINNET_GATEWAY_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
export const ARC_MAINNET_GATEWAY_MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
export const ARC_MAINNET_X402_NETWORK = "eip155:5042";
export const ARC_MAINNET_USDC = "0x3600000000000000000000000000000000000000";
export const ARC_MAINNET_FACILITATOR = "https://gateway-api.circle.com";

export type X402Availability =
  | { available: true; scheme: "exact"; settlement: "GatewayWalletBatched" }
  | { available: false; code: "x402_disabled" | "x402_misconfigured"; reason: string };

function enabled(raw: string | undefined): boolean {
  return raw === "1" || raw?.toLowerCase() === "true";
}

export function validateX402Availability(
  env: Record<string, string | undefined> = process.env
): X402Availability {
  const net = getNetworkConfig(env);
  if (net.name !== "mainnet") return { available: true, scheme: "exact", settlement: "GatewayWalletBatched" };
  if (!enabled(env.X402_MAINNET_ENABLED)) {
    return { available: false, code: "x402_disabled", reason: "x402 is disabled on Arc Mainnet. Set X402_MAINNET_ENABLED=true only after validating the production configuration." };
  }
  const payTo = env.SELLER_ADDRESS?.trim() ?? "";
  const failures: string[] = [];
  if (net.chainId !== 5042 || net.x402Network !== ARC_MAINNET_X402_NETWORK) failures.push("network must be eip155:5042");
  if (net.usdcAddress.toLowerCase() !== ARC_MAINNET_USDC.toLowerCase()) failures.push("USDC address does not match Arc mainnet");
  if ((net.x402VerifierContract ?? "").toLowerCase() !== ARC_MAINNET_GATEWAY_WALLET.toLowerCase()) failures.push("GatewayWallet verifier does not match the documented mainnet deployment");
  if (net.gatewayUrl !== ARC_MAINNET_FACILITATOR) failures.push("facilitator URL must be https://gateway-api.circle.com");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || /^0x0{40}$/i.test(payTo)) failures.push("SELLER_ADDRESS/payTo must be a non-zero EVM address");
  if (failures.length) return { available: false, code: "x402_misconfigured", reason: `Invalid Arc Mainnet x402 configuration: ${failures.join("; ")}.` };
  return { available: true, scheme: "exact", settlement: "GatewayWalletBatched" };
}

export function x402UnavailableResponse(): NextResponse | null {
  const availability = validateX402Availability();
  return availability.available ? null : NextResponse.json(
    { success: false, error: availability.reason, code: availability.code },
    { status: 503 }
  );
}
