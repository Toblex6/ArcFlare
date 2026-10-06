// src/lib/x402-gateway.ts
//
// Mainnet safety gate for the client-side Circle GatewayClient
// (@circle-fin/x402-batching/client) used by the x402 pay / withdraw /
// deposit / balance paths and the payroll-x402 sweep.
//
// Decision (final-fix pass, Option B): the Gateway feature is NOT
// Mainnet-ready — there is NO verified Arc Mainnet Gateway chain value
// configured anywhere in this repository (no ARC_MAINNET_GATEWAY_CHAIN,
// no `chain: "arc"` literal in src/, only the SDK's own unconfigured
// capability). Every GatewayClient path therefore FAILS CLOSED on mainnet
// with a clear "not available on Arc Mainnet yet" response instead of
// silently executing against Arc Testnet.
//
// Testnet behavior is unchanged: requireGatewayChain() returns "arcTestnet".
//
// Usage in route handlers (server-only — GatewayClient needs private keys):
//   import { isGatewayAvailable, requireGatewayChain, gatewayUnavailableBody } from "@/lib/x402-gateway";
//   if (!isGatewayAvailable()) {
//     return NextResponse.json(gatewayUnavailableBody(), { status: 503 });
//   }
//   const client = new GatewayClient({ chain: requireGatewayChain(), privateKey });
// The construction-time requireGatewayChain() is defense-in-depth: even if
// a route guard were ever removed, instantiating the client on mainnet
// throws instead of silently targeting testnet.
//
// NOTE: this module is intentionally dependency-free apart from the
// authoritative network config (no next/server import) so unit tests can
// import it directly. Route handlers wrap gatewayUnavailableBody() in
// NextResponse.json(..., { status: 503 }) themselves.
//
// This module does NOT touch src/lib/x402.ts (frozen withGateway +
// BatchFacilitatorClient, which already resolves its facilitator URL from
// getNetworkConfig().gatewayUrl and fails closed without
// ARC_MAINNET_GATEWAY_URL).

import { getArcNetworkName } from "@/lib/config/network";

/** Error code surfaced to API callers when Gateway is hit on mainnet. */
export const GATEWAY_MAINNET_UNAVAILABLE_CODE = "gateway_mainnet_unavailable" as const;

/** User-facing message for the mainnet fail-closed response. */
export const GATEWAY_MAINNET_UNAVAILABLE_MESSAGE =
  "x402 Gateway is not available on Arc Mainnet yet." as const;

/** Thrown when a GatewayClient is constructed while on Arc Mainnet. */
export class GatewayMainnetUnavailableError extends Error {
  readonly code = GATEWAY_MAINNET_UNAVAILABLE_CODE;
  constructor() {
    super(
      `${GATEWAY_MAINNET_UNAVAILABLE_MESSAGE} Refusing to execute against Arc Testnet from a mainnet request.`
    );
    this.name = "GatewayMainnetUnavailableError";
  }
}

/**
 * True when the Circle Gateway feature may execute (i.e. NOT mainnet).
 * Testnet (the default) returns true; mainnet returns false.
 */
export function isGatewayAvailable(
  env: Record<string, string | undefined> = process.env
): boolean {
  return getArcNetworkName(env) !== "mainnet";
}

/**
 * The Circle Gateway chain identifier for the selected network.
 * Testnet → "arcTestnet" (unchanged behavior). Mainnet → throws
 * GatewayMainnetUnavailableError (fail closed — never "arcTestnet",
 * never a guessed mainnet value).
 */
export function requireGatewayChain(
  env: Record<string, string | undefined> = process.env
): "arcTestnet" {
  if (getArcNetworkName(env) === "mainnet") {
    throw new GatewayMainnetUnavailableError();
  }
  return "arcTestnet";
}

/**
 * Minimal 503 body for route handlers to return on mainnet.
 * No private keys, no chain internals — just the reason + code.
 */
export function gatewayUnavailableBody(): {
  success: false;
  error: string;
  code: typeof GATEWAY_MAINNET_UNAVAILABLE_CODE;
} {
  return {
    success: false,
    error: GATEWAY_MAINNET_UNAVAILABLE_MESSAGE,
    code: GATEWAY_MAINNET_UNAVAILABLE_CODE,
  };
}
