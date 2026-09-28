// src/app/api/network/route.ts
//
// READ-ONLY public network descriptor — the runtime bridge that lets the
// browser/client render the SAME already-resolved network state as the
// server (GET /api/network). No auth, no secrets, no writes.
//
// ROOT CAUSE this fixes: the browser bundle can only see
// NEXT_PUBLIC_ARC_NETWORK (embedded at build time). When production sets
// ARC_NETWORK=mainnet on the server but the client bundle was built without
// the public variable, every client call to getNetworkConfig()/arcLabel()/
// arcTestnet.name resolves to "testnet" and the live site renders
// "Arc Testnet" badges despite the server running mainnet. Client display
// components must consume THIS endpoint (via useNetwork() in
// src/components/NetworkContext.tsx) instead of reading the client-side
// env directly — with a production-safe ("Arc") default while loading.
//
// Response shape (public topology only — never secrets, never keys):
//   { name, label, chainId, explorerBaseUrl, erc8183Address }
// - name: "testnet" | "mainnet" (server-resolved via getNetworkConfig)
// - label: user-visible network label ("Arc" on mainnet, "Arc Testnet" on testnet)
// - chainId: server-resolved Arc EVM chain id
// - explorerBaseUrl: server-resolved block explorer base URL
// - erc8183Address: server-resolved ERC-8183 protocol address, or null when
//   unconfigured (mainnet without ARC_MAINNET_ERC8183_ADDRESS — per-feature
//   fail-closed). Public on-chain topology, safe to expose.
//
// Failure semantics: display-only. When the server network config is
// misconfigured this route returns the production-safe descriptor
// ({ name: "mainnet", label: "Arc", ... }) with ok:false so clients keep
// rendering production copy — money paths enforce configuration separately
// and are unaffected.
import { NextResponse } from "next/server";
import { getNetworkConfig } from "@/lib/config/network";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cfg = getNetworkConfig();
    return NextResponse.json({
      ok: true,
      name: cfg.name,
      label: cfg.name === "mainnet" ? "Arc" : "Arc Testnet",
      chainId: cfg.chainId,
      explorerBaseUrl: cfg.explorerBaseUrl,
      erc8183Address: cfg.erc8183Address,
    });
  } catch {
    // Production-safe fallback: never render a test label because the
    // server config errored. Money paths fail closed elsewhere.
    return NextResponse.json({
      ok: false,
      name: "mainnet",
      label: "Arc",
      chainId: null,
      explorerBaseUrl: null,
      erc8183Address: null,
    });
  }
}
