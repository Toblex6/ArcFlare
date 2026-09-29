// src/lib/wallet/arcChains.ts
//
// Static Arc chain definitions + server-driven selection for the BROWSER.
//
// ROOT CAUSE this fixes: the browser bundle can only see
// NEXT_PUBLIC_ARC_NETWORK (embedded at build time). When production sets
// ARC_NETWORK=mainnet on the server but the client bundle was built without
// the public variable, every client-side chain object resolves to testnet
// (chain 5042002) and wallet switching targets Arc Testnet even though the
// server runs Arc mainnet (chain 5042).
//
// Fix: Arc Mainnet is defined STATICALLY here (chain 5042, mainnet RPC and
// explorer — the confirmed production values, also documented in
// .env.example's ARC MAINNET section), and every wallet-switching call site
// selects its target from the SERVER-resolved chain id (GET /api/network via
// useActiveArcChain()) instead of a build-time chain object. Production can
// therefore never silently fall back to testnet; testnet development keeps
// working because a testnet server resolves chain 5042002.
//
// This module is client-safe (viem-only, no node imports, no secrets).

import { defineChain } from 'viem';

/** Arc Mainnet EVM chain ID (production). */
export const ARC_MAINNET_CHAIN_ID = 5042;

/** Arc Testnet EVM chain ID (development). */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/**
 * Arc Mainnet chain definition — static so the production browser always
 * carries it, independent of build-time env.
 *   chain ID = 5042, USDC = 0x3600000000000000000000000000000000000000,
 *   RPC = https://rpc.mainnet.arc.io, explorer = https://explorer.arc.io.
 */
export const arcMainnet = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: {
    decimals: 18,
    name: 'ARC',
    symbol: 'ARC',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.mainnet.arc.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: 'https://explorer.arc.io',
    },
  },
  testnet: false,
});

/**
 * Resolve the active Arc chain id from the SERVER-resolved value.
 * Only the two known Arc chain ids are ever returned; anything else
 * (null while /api/network loads, error fallback, unknown) resolves to
 * Arc Mainnet — the production-safe choice. Never testnet by default.
 */
export function resolveActiveArcChainId(
  serverChainId: number | null | undefined
): number {
  if (
    serverChainId === ARC_MAINNET_CHAIN_ID ||
    serverChainId === ARC_TESTNET_CHAIN_ID
  ) {
    return serverChainId;
  }
  return ARC_MAINNET_CHAIN_ID;
}
