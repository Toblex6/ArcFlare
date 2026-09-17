// src/lib/bridge/sourceChains.ts
//
// CANONICAL EXTERNAL BRIDGE source-chain table — the single authority for
// which chains an EXTERNAL (browser-controlled) wallet can bridge USDC from
// into Arc Testnet. Both the browser Bridge UI and the server intent/verify
// routes resolve through this module — never through provider docs, wagmi
// chain lists, or a second inline table.
//
// Identifier conventions (kept distinct on purpose):
//   - `id`        Circle Bridge Kit's BridgeChain enum string (e.g.
//                 'Arbitrum_Sepolia') — the representation used at the
//                 BridgeKit boundary (kit.bridge / kit.retry).
//   - `chainId`   numeric EVM chain id — used only where the wallet
//                 connector requires it (chain switching, balance reads).
//
// Address values below are the source-chain USDC contracts from the
// INSTALLED @circle-fin/bridge-kit chain definitions (verified against
// node_modules/@circle-fin/bridge-kit/chains.cjs, bridge-kit 1.13.0).
// Explorer templates come from the same definitions ({hash} placeholder).
// `circleBlockchain` is Circle's Developer-Controlled Wallets identifier for
// the same chain (kept so server code that still keys off it — cctp-v2.ts —
// derives from here instead of duplicating the table).
//
// TESTNET ONLY. There is no mainnet entry and no mainnet override input:
// the external bridge refuses closed outside testnet (see the intent route).
// This module is client-safe (pure data + pure functions, no secrets).

export interface BridgeSourceChain {
  /** BridgeKit BridgeChain enum string — passed to kit.bridge()/kit.retry(). */
  id: string;
  /** Human label for the source-chain picker. */
  label: string;
  /** Numeric EVM chain id for the wallet connector. */
  chainId: number;
  /** Source-chain USDC contract (6 decimals on every chain here). */
  usdcAddress: `0x${string}`;
  /** Source explorer tx template with a {hash} placeholder. */
  explorerTxTemplate: string;
  /** Circle Developer-Controlled Wallets blockchain identifier. */
  circleBlockchain: string;
}

const SOURCES: BridgeSourceChain[] = [
  {
    id: 'Arbitrum_Sepolia',
    label: 'Arbitrum Sepolia',
    chainId: 421614,
    usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    explorerTxTemplate: 'https://sepolia.arbiscan.io/tx/{hash}',
    circleBlockchain: 'ARB-SEPOLIA',
  },
  {
    id: 'Base_Sepolia',
    label: 'Base Sepolia',
    chainId: 84532,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorerTxTemplate: 'https://sepolia.basescan.org/tx/{hash}',
    circleBlockchain: 'BASE-SEPOLIA',
  },
  {
    id: 'Optimism_Sepolia',
    label: 'Optimism Sepolia',
    chainId: 11155420,
    usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    explorerTxTemplate: 'https://sepolia-optimistic.etherscan.io/tx/{hash}',
    circleBlockchain: 'OP-SEPOLIA',
  },
  {
    id: 'Ethereum_Sepolia',
    label: 'Ethereum Sepolia',
    chainId: 11155111,
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    explorerTxTemplate: 'https://sepolia.etherscan.io/tx/{hash}',
    circleBlockchain: 'ETH-SEPOLIA',
  },
  {
    id: 'Polygon_Amoy_Testnet',
    label: 'Polygon Amoy',
    chainId: 80002,
    usdcAddress: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
    explorerTxTemplate: 'https://amoy.polygonscan.com/tx/{hash}',
    circleBlockchain: 'MATIC-AMOY',
  },
];

/** Canonical supported source set (fresh copies — callers must not mutate). */
export function getBridgeSourceChains(): BridgeSourceChain[] {
  return SOURCES.map((s) => ({ ...s }));
}

/** Back-compat constant: the canonical supported source set. */
export const BRIDGE_SOURCE_CHAINS: readonly BridgeSourceChain[] = SOURCES.map((s) => ({ ...s }));

export function getBridgeSourceChain(id: string): BridgeSourceChain | null {
  const found = SOURCES.find((s) => s.id === id);
  return found ? { ...found } : null;
}

export function getBridgeSourceChainByChainId(chainId: number): BridgeSourceChain | null {
  const found = SOURCES.find((s) => s.chainId === chainId);
  return found ? { ...found } : null;
}

export function isSupportedBridgeSource(id: unknown): boolean {
  return typeof id === 'string' && SOURCES.some((s) => s.id === id);
}

export function sourceExplorerTxUrl(sourceId: string, txHash: string): string | null {
  const s = getBridgeSourceChain(sourceId);
  if (!s) return null;
  return s.explorerTxTemplate.replace('{hash}', txHash);
}

// ─── Amount rules (USDC, canonical 6-decimal base units) ─────────────────────
// One authority for "is this bridge amount sane", shared by the browser form
// and the server intent route so both reject the same inputs.

export const BRIDGE_USDC_DECIMALS = 6;

export type BridgeAmountError =
  | 'EMPTY'
  | 'MALFORMED'
  | 'TOO_MANY_DECIMALS'
  | 'ZERO_OR_NEGATIVE'
  | 'INSUFFICIENT_BALANCE';

/**
 * Parse a user-entered USDC amount into exact 6-decimal base units.
 * Returns null for anything that is not a well-formed positive decimal
 * with at most 6 fractional digits. Never throws, never rounds.
 */
export function parseBridgeAmountToBaseUnits(input: unknown): bigint | null {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  if (frac.length > BRIDGE_USDC_DECIMALS) return null;
  const padded = (frac + '000000').slice(0, BRIDGE_USDC_DECIMALS);
  try {
    const units = BigInt(whole) * 1_000_000n + BigInt(padded);
    if (units <= 0n) return null;
    return units;
  } catch {
    return null;
  }
}

/**
 * Classify why a raw amount string is unusable (for friendly UI copy).
 * Balance-aware only when a balance is supplied — the server intent route
 * passes null (it cannot know the external wallet's balance) and the
 * browser passes the live on-chain balance.
 */
export function validateBridgeAmount(
  input: unknown,
  balanceBaseUnits: bigint | null = null
): { ok: true; amountBaseUnits: bigint } | { ok: false; error: BridgeAmountError } {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'EMPTY' };
  const t = (input as string).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'MALFORMED' };
  const [, frac = ''] = t.split('.');
  if (frac.length > BRIDGE_USDC_DECIMALS) return { ok: false, error: 'TOO_MANY_DECIMALS' };
  const units = parseBridgeAmountToBaseUnits(t);
  if (units === null || units <= 0n) return { ok: false, error: 'ZERO_OR_NEGATIVE' };
  if (balanceBaseUnits !== null && units > balanceBaseUnits) {
    return { ok: false, error: 'INSUFFICIENT_BALANCE' };
  }
  return { ok: true, amountBaseUnits: units };
}

/** 6-decimal base units -> exact display string (no float). */
export function formatBridgeBaseUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const s = abs.toString().padStart(7, '0');
  const display = `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0';
  return negative ? `-${display}` : display;
}
