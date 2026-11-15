// src/lib/stream/streamGuard.ts
//
// Single per-request gate for every stream route handler — the stream
// counterpart of src/lib/escrow/escrowGuard.ts.
//
// ArcFlareStream is deployed and production-used on Arc TESTNET only
// (0xd8ca3Bbc…A52B). Stream resolves per network through
// requireStreamAddress() (src/lib/config/network.ts):
//
//   testnet → ARCFLARE_STREAM_CONTRACT_ADDRESS (unchanged behavior)
//   mainnet → ARC_MAINNET_STREAM_ADDRESS only — never the testnet contract
//
// When the selected network has no (valid) stream address, every stream route
// answers HTTP 503 with `stream_unavailable` / `stream_misconfigured` BEFORE
// any body parsing, auth lookup, RPC read, or transaction creation, so no
// funds can move and no Circle/viem call is ever attempted.
//
// Usage (first lines of the handler):
//   const stream = streamAddressOr503();
//   if ("response" in stream) return stream.response;
//   const STREAM_CONTRACT = stream.address;

import { NextResponse } from "next/server";
import {
  StreamMisconfiguredError,
  StreamUnavailableError,
  requireStreamAddress,
} from "@/lib/config/network";

export function streamAddressOr503():
  | { address: `0x${string}` }
  | { response: NextResponse } {
  try {
    return { address: requireStreamAddress() as `0x${string}` };
  } catch (e) {
    if (e instanceof StreamUnavailableError) {
      return {
        response: NextResponse.json(
          { success: false, error: "stream_unavailable", message: e.message },
          { status: 503 }
        ),
      };
    }
    if (e instanceof StreamMisconfiguredError) {
      return {
        response: NextResponse.json(
          { success: false, error: "stream_misconfigured", message: e.message },
          { status: 503 }
        ),
      };
    }
    throw e;
  }
}
