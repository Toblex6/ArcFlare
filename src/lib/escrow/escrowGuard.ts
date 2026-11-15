// src/lib/escrow/escrowGuard.ts
//
// Single per-request gate for every escrow route handler.
//
// FlareHQEscrow is deployed and production-used on Arc TESTNET only. There is
// no Arc Mainnet deployment, so escrow resolves per network through
// requireEscrowAddress() (src/lib/config/network.ts):
//
//   testnet → ARCFLARE_ESCROW_CONTRACT_ADDRESS (unchanged behavior)
//   mainnet → ARC_MAINNET_ESCROW_ADDRESS only — never the testnet contract
//
// When the selected network has no (valid) escrow address, every escrow route
// answers HTTP 503 with `escrow_unavailable` / `escrow_misconfigured` BEFORE
// any body parsing, auth lookup, RPC read, or transaction creation, so no
// funds can move and no Circle/viem call is ever attempted.
//
// Usage (first lines of the handler):
//   const escrow = escrowAddressOr503();
//   if ("response" in escrow) return escrow.response;
//   const ESCROW_CONTRACT = escrow.address;

import { NextResponse } from "next/server";
import {
  EscrowMisconfiguredError,
  EscrowUnavailableError,
  requireEscrowAddress,
} from "@/lib/config/network";

export function escrowAddressOr503():
  | { address: `0x${string}` }
  | { response: NextResponse } {
  try {
    return { address: requireEscrowAddress() as `0x${string}` };
  } catch (e) {
    if (e instanceof EscrowUnavailableError) {
      // Mainnet message: "Escrow is not available on mainnet".
      return {
        response: NextResponse.json(
          { success: false, error: "escrow_unavailable", message: e.message },
          { status: 503 }
        ),
      };
    }
    if (e instanceof EscrowMisconfiguredError) {
      return {
        response: NextResponse.json(
          { success: false, error: "escrow_misconfigured", message: e.message },
          { status: 503 }
        ),
      };
    }
    throw e;
  }
}
