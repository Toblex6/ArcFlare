// src/lib/bridge/sourceViemChains.ts
//
// viem chain objects for the canonical EXTERNAL Bridge source set.
// Client-safe (viem/chains is isomorphic) — shared by the browser balance
// reads / chain switching and the server receipt verification so both sides
// resolve the same RPC/explorer/chain-id view. The SUPPORTED SET itself is
// owned by src/lib/bridge/sourceChains.ts; this module only maps chainId ->
// viem chain object (returns null for anything outside the canonical set).

import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  sepolia,
  polygonAmoy,
  type Chain,
} from 'viem/chains';

const BY_CHAIN_ID: Record<number, Chain> = {
  [arbitrumSepolia.id]: arbitrumSepolia,
  [baseSepolia.id]: baseSepolia,
  [optimismSepolia.id]: optimismSepolia,
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy,
};

export function sourceViemChainFor(chainId: number): Chain | null {
  return BY_CHAIN_ID[chainId] ?? null;
}
