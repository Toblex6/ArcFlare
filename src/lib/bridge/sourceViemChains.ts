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
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  type Chain,
} from 'viem/chains';
import { fallback, http } from 'viem';
import { getBridgeSourceChainByChainId, getBridgeSourceChains } from './sourceChains';

const BY_CHAIN_ID: Record<number, Chain> = {
  [arbitrumSepolia.id]: arbitrumSepolia,
  [baseSepolia.id]: baseSepolia,
  [optimismSepolia.id]: optimismSepolia,
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy,
  // Mainnet external-bridge sources (Step D) — same canonical table owner
  // (sourceChains.ts) via chainId; testnet entries above are unchanged.
  [mainnet.id]: mainnet,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
  [avalanche.id]: avalanche,
};

export function sourceViemChainFor(chainId: number): Chain | null {
  const source = getBridgeSourceChainByChainId(chainId, 'mainnet') ?? getBridgeSourceChainByChainId(chainId, 'testnet');
  const chain = BY_CHAIN_ID[chainId];
  if (!source || !chain) return null;
  return {
    ...chain,
    name: source.label,
    nativeCurrency: source.nativeCurrency,
    rpcUrls: { default: { http: [...source.rpcUrls] } },
  };
}

/** Registration derives from the canonical tables, not a second supported set. */
export function getBridgeSourceViemChains(): Chain[] {
  return [...getBridgeSourceChains('testnet'), ...getBridgeSourceChains('mainnet')].map((source) => {
    const chain = sourceViemChainFor(source.chainId);
    if (!chain) throw new Error(`Missing viem definition for bridge source ${source.id}.`);
    return chain;
  });
}

export function sourceRpcTransport(chainId: number) {
  const chain = sourceViemChainFor(chainId);
  if (!chain) throw new Error('Unsupported bridge source RPC.');
  return fallback(chain.rpcUrls.default.http.map((url) => http(url)), { rank: false });
}
