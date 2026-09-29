// src/components/NetworkContext.tsx
//
// Client-side view of the ALREADY-RESOLVED server network state.
//
// Single-authority rule: src/lib/config/network.ts remains the ONE source
// of truth. The server resolves it (ARC_NETWORK) and exposes the public
// descriptor via GET /api/network; this module ONLY transports that
// resolved state into client components — it never re-derives the network
// from client-side env (which cannot see ARC_NETWORK and would fall back
// to testnet on a mainnet server).
//
// PRODUCTION SAFETY: the default/loading/error state is the production
// descriptor ({ name: "mainnet", label: "Arc", isTestnet: false }), never
// a test label. A client that cannot reach /api/network yet (SSR,
// first paint, offline) renders "Arc" — it must never flash "Arc Testnet"
// on the live site. Testnet developers still see the correct testnet label
// once /api/network resolves on a testnet server.
//
// Usage:
//   <NetworkProvider> (mounted once in src/app/providers.tsx)
//   const { label, isTestnet, chainId, explorerBaseUrl, loaded } = useNetwork();
//   const label = useArcLabel(); // "Arc" (mainnet) / "Arc Testnet" (testnet)
//
// displayChain(raw): sanitizes legacy/stored chain strings for display —
// any value mentioning testnet/ARC-TESTNET/Sepolia renders as "Arc" so
// historical testnet rows can never leak a test label into production UI.
// Pure, display-only, never used for chain selection or signing.
'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/config/network';
import { arcMainnet, resolveActiveArcChainId } from '@/lib/wallet/arcChains';
import { arcTestnet } from '@/lib/wagmi';

export interface NetworkState {
  /** "testnet" | "mainnet" — server-resolved. Defaults to "mainnet" (production-safe). */
  name: 'testnet' | 'mainnet';
  /** User-visible label: "Arc" on mainnet, "Arc Testnet" on testnet. Never blank. */
  label: string;
  /** Server-resolved chain id, or null while unresolved. Display-only. */
  chainId: number | null;
  /** Server-resolved explorer base URL, or null while unresolved. Display-only. */
  explorerBaseUrl: string | null;
  /**
   * Server-resolved ERC-8183 protocol address, or null when unconfigured
   * (mainnet without ARC_MAINNET_ERC8183_ADDRESS) or unresolved.
   * Display-only; features fail closed via the server, never via this field.
   */
  erc8183Address: string | null;
  /** True once /api/network has resolved (either ok or fallback). */
  loaded: boolean;
  /** Convenience: name === "testnet". False until proven testnet. */
  isTestnet: boolean;
}

const PRODUCTION_SAFE_STATE: NetworkState = {
  name: 'mainnet',
  label: 'Arc',
  chainId: null,
  explorerBaseUrl: null,
  erc8183Address: null,
  loaded: false,
  isTestnet: false,
};

const NetworkContext = createContext<NetworkState>(PRODUCTION_SAFE_STATE);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<NetworkState>(PRODUCTION_SAFE_STATE);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/network', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const name = data?.name === 'testnet' ? 'testnet' : 'mainnet';
        setState({
          name,
          label: typeof data?.label === 'string' && data.label ? data.label : name === 'mainnet' ? 'Arc' : 'Arc Testnet',
          chainId: typeof data?.chainId === 'number' ? data.chainId : null,
          explorerBaseUrl: typeof data?.explorerBaseUrl === 'string' ? data.explorerBaseUrl : null,
          erc8183Address: typeof data?.erc8183Address === 'string' ? data.erc8183Address : null,
          loaded: true,
          isTestnet: name === 'testnet',
        });
      } catch {
        // Keep the production-safe state, mark loaded so UI doesn't hang.
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <NetworkContext.Provider value={state}>{children}</NetworkContext.Provider>;
}

/** Server-resolved network state (production-safe defaults before resolve). */
export function useNetwork(): NetworkState {
  return useContext(NetworkContext);
}

/** Server-resolved user-visible network label ("Arc" / "Arc Testnet"). */
export function useArcLabel(): string {
  return useContext(NetworkContext).label;
}

/**
 * Server-driven wallet target for chain COMPARISONS and SWITCHING.
 *
 * The browser bundle cannot see the server's ARC_NETWORK, so every
 * wallet call site must use THIS hook (backed by GET /api/network) instead
 * of a build-time chain object. Unresolved/unknown state defaults to Arc
 * Mainnet (chain 5042) — production-safe, never silently testnet. A testnet
 * server resolves 5042002 and development keeps working unchanged.
 *
 * Display copy must still use useNetwork()/useArcLabel(); this hook is for
 * chain mechanics only (comparisons, ensureArcNetwork target, RPC/explorer
 * fallbacks).
 */
export function useActiveArcChain(): {
  /** Active Arc chain id: server-resolved, production-safe 5042 default. */
  chainId: number;
  /** Wagmi chain object matching chainId (mainnet static or env testnet). */
  chain: typeof arcMainnet;
  /** Raw server-resolved chain id (null while /api/network is unresolved). */
  serverChainId: number | null;
  /** True once /api/network has resolved. */
  loaded: boolean;
} {
  const { chainId: serverChainId, loaded } = useContext(NetworkContext);
  const chainId = resolveActiveArcChainId(serverChainId);
  return {
    chainId,
    chain: (chainId === arcMainnet.id ? arcMainnet : arcTestnet) as typeof arcMainnet,
    serverChainId,
    loaded,
  };
}

/**
 * Explorer links bound to the SERVER-resolved explorer base (production-safe
 * fallback to the client config while /api/network is unresolved).
 * Display-only hrefs — never chain selection, never signing. Using these
 * instead of calling explorerTxUrl()/explorerAddressUrl() directly keeps
 * link targets consistent with the resolved network even when the client
 * bundle was built without NEXT_PUBLIC_ARC_NETWORK.
 */
export function useExplorer(): {
  txUrl: (hash: string) => string;
  addressUrl: (address: string) => string;
} {
  const { explorerBaseUrl } = useContext(NetworkContext);
  return {
    txUrl: (hash: string) =>
      explorerBaseUrl ? `${explorerBaseUrl}/tx/${hash}` : explorerTxUrl(hash),
    addressUrl: (address: string) =>
      explorerBaseUrl ? `${explorerBaseUrl}/address/${address}` : explorerAddressUrl(address),
  };
}

/**
 * Sanitize a stored/raw chain string for DISPLAY. Legacy rows may carry
 * testnet-era values ("Arc Testnet v1.0", "ARC-TESTNET", "Arc Testnet",
 * Sepolia variants); on the production site those must render as "Arc".
 * Empty/unknown input renders as "Arc" (production-safe, never blank).
 * Pure display helper — never chain selection, never signing.
 */
export function displayChain(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return 'Arc';
  const lower = s.toLowerCase();
  if (
    lower.includes('testnet') ||
    lower.includes('sepolia') ||
    lower.includes('amoy') ||
    lower === 'arc-testnet' ||
    lower === 'arc_testnet'
  ) {
    return 'Arc';
  }
  return s;
}
