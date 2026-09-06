// src/lib/routing/canonical.ts
//
// Canonical routing identity + constants for Payment Routing v1.
// One pool, one router, one hop, USDC/EURC only. Anything not named here
// cannot be quoted or verified — client input never supplies addresses.

import { createPublicClient, http } from 'viem';
import { arcTestnet } from '@/src/lib/wagmi';

// ── Policy constants ─────────────────────────────────────────────────────────
export const ROUTING_QUOTE_TTL_MS = 5 * 60 * 1000; // short-lived quotes (~5 min)
export const ROUTING_SLIPPAGE_BPS = 100; // 1% slippage tolerance baked into minOut
export const ROUTING_MAX_DEPTH_BPS = 1000; // quoted output <= 10% of pool reserveOut
export const ROUTING_MAX_OUTPUT_BASE = 1_000_000000n; // absolute cap: 1000.00 (6-dec base units)
// Final-leg shortfall buffers, by OUTPUT token (base units). Measured on Arc
// Testnet via scripts/router-e2e.ts: EURC legs are fee-free (merchant credit
// == pool quote exactly); USDC merchant credit ran ~0.0034 below quote across
// the pool→router→merchant legs. Buffers sit above the measurements.
export const ROUTING_OUT_FEE_BUFFER: Record<'USDC' | 'EURC', bigint> = {
  USDC: 5000n, // 0.005
  EURC: 1000n, // 0.001 (conservative; measured 0)
};

// ── Typed routing error (carries the HTTP status for the route wrapper) ─────
export function routingError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

// ── Canonical addresses (server-resolved from env, never client input) ──────
export interface RoutingConfig {
  poolAddress: string;
  routerAddress: string;
  rpcUrl: string;
}

function isAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

export function getRoutingConfig(): RoutingConfig {
  const poolAddress = (process.env.SWAP_POOL_CONTRACT_ADDRESS ?? '').trim();
  const routerAddress = (process.env.PAYMENT_ROUTER_CONTRACT_ADDRESS ?? '').trim();
  if (!isAddress(poolAddress)) {
    throw routingError(503, 'Payment routing is not configured (canonical pool missing).');
  }
  if (!isAddress(routerAddress)) {
    throw routingError(503, 'Payment routing is not configured (canonical router missing).');
  }
  return {
    poolAddress,
    routerAddress,
    rpcUrl: (process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network').trim(),
  };
}

// ── Pool read ABI (quote + reserves + pair identity only) ───────────────────
export const SWAP_POOL_READ_ABI = [
  {
    name: 'getQuote',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    name: 'reserveA',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'reserveB',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenA',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenB',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export function getRoutingPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
}

// ── RPC with retry (Arc cluster is intermittently flaky — retry, don't fail) ─
export async function readWithRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw routingError(503, `Routing RPC read failed (${label}): ${(last as Error)?.message ?? last}`);
}
