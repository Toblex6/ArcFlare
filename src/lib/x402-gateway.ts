// Network gate for @circle-fin/x402-batching/client GatewayClient paths.
// Mainnet is supported by the installed SDK as chain "arc" (domain 26).
// X402_MAINNET_ENABLED and the same config validation used by protected x402
// routes gate every balance/deposit/pay/withdraw action.

import { getArcNetworkName } from "@/lib/config/network";
import { validateX402Availability } from "@/lib/x402/availability";

export const GATEWAY_MAINNET_UNAVAILABLE_CODE = "gateway_mainnet_unavailable" as const;

export class GatewayMainnetUnavailableError extends Error {
  readonly code = GATEWAY_MAINNET_UNAVAILABLE_CODE;
  constructor(message = "x402 Gateway is unavailable on Arc Mainnet.") {
    super(message);
    this.name = "GatewayMainnetUnavailableError";
  }
}

export function isGatewayAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return validateX402Availability(env).available;
}

export function requireGatewayChain(env: Record<string, string | undefined> = process.env): "arcTestnet" | "arc" {
  const validation = validateX402Availability(env);
  if (!validation.available) throw new GatewayMainnetUnavailableError(validation.reason);
  return getArcNetworkName(env) === "mainnet" ? "arc" : "arcTestnet";
}

export function gatewayUnavailableBody(env: Record<string, string | undefined> = process.env) {
  const validation = validateX402Availability(env);
  return {
    success: false as const,
    error: validation.available ? "x402 Gateway is unavailable." : validation.reason,
    code: GATEWAY_MAINNET_UNAVAILABLE_CODE,
  };
}
