// src/lib/jobs/erc8183Guard.ts
//
// Single per-request gate for every ERC-8183-dependent route handler.
//
// ERC-8183 is an EXTERNAL protocol dependency with no verified Arc Mainnet
// address (2026-09-23 decision: external, unverified, never deploy our own,
// never invent an address, stay fail-closed). On testnet the pinned reference
// implementation resolves normally; on mainnet without
// ARC_MAINNET_ERC8183_ADDRESS every dependent feature answers HTTP 503
// `erc8183_unavailable` instead of crashing, falling back to testnet, or
// calling a fake address. Payment/merchant/consumer flows that do not need
// ERC-8183 are unaffected.
//
// Usage (first lines of the handler):
//   const erc8183 = erc8183AddressOr503();
//   if ("response" in erc8183) return erc8183.response;
//   const ERC8183_ADDRESS = erc8183.address;

import { NextResponse } from "next/server";
import {
  Erc8183UnavailableError,
  requireErc8183Address,
} from "@/lib/config/network";

export function erc8183AddressOr503():
  | { address: `0x${string}` }
  | { response: NextResponse } {
  try {
    return { address: requireErc8183Address() as `0x${string}` };
  } catch (e) {
    if (e instanceof Erc8183UnavailableError) {
      return {
        response: NextResponse.json(
          { error: "erc8183_unavailable", message: e.message },
          { status: 503 }
        ),
      };
    }
    throw e;
  }
}
