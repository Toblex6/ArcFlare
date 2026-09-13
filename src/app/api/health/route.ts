// src/app/api/health/route.ts
//
// READ-ONLY mainnet-readiness / liveness probe (no auth, no secrets, no writes).
// Reports only configuration SHAPE (which network is selected, whether required
// mainnet inputs are present/well-formed) — never secret values, never balances,
// never transaction submission. Safe to expose to load balancers/uptime checks.
//
// Response shape:
//   { ok, network, mainnet: { configured, errorCount }, walletEnv: { ok, errorCount },
//     timestamp }
// - testnet: always ok (no mainnet inputs required).
// - mainnet: ok only when every ARC_MAINNET_* input is present and well-formed
//   AND the startup wallet/key validation passes; otherwise ok=false with an
//   error COUNT only (messages stay generic here; full detail is server-logged).
//
// Liveness vs readiness: this route runs validateWalletEnv() (which covers
// signer pairs, contract addresses, Circle creds, secrets), so a 503 here
// means "not ready to serve money paths". Load balancers that only need
// "process is up" should treat any HTTP response (200 OR 503) as live and
// use `ok === true` as the readiness signal.
import { NextResponse } from "next/server";
import { getArcNetworkName, validateNetworkEnv } from "@/lib/config/network";
import { validateWalletEnv } from "@/lib/env/walletEnvCheck";

export const dynamic = "force-dynamic";

export async function GET() {
  const network = getArcNetworkName();
  let networkErrors: string[] = [];
  try {
    networkErrors = validateNetworkEnv();
  } catch (e: any) {
    networkErrors = [e?.message ?? String(e)];
  }
  let walletErrors: string[] = [];
  try {
    walletErrors = validateWalletEnv().errors;
  } catch (e: any) {
    walletErrors = [e?.message ?? String(e)];
  }
  // Never leak values: report counts only on this public surface.
  const ok = networkErrors.length === 0 && walletErrors.length === 0;
  return NextResponse.json(
    {
      ok,
      network,
      mainnet:
        network === "mainnet"
          ? { configured: networkErrors.length === 0, errorCount: networkErrors.length }
          : { configured: true, errorCount: 0, note: "testnet selected; no mainnet inputs required" },
      walletEnv: { ok: walletErrors.length === 0, errorCount: walletErrors.length },
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 }
  );
}
