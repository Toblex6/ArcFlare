// src/lib/bridge/preflight.ts
//
// Pre-signing balance/gas preflight for the EXTERNAL Bridge — the fix for
// the "silently stuck at PREPARING" reliability gap.
//
// Before kit.bridge() is invoked (i.e. before the user is asked to sign
// ANYTHING), the UI re-reads two live balances on the SELECTED source chain
// and refuses to proceed when either is insufficient:
//
//   1. native gas — the wallet must hold at least MIN_NATIVE_WEI of the
//      chain's native asset (approve + burn are two source-chain txs);
//   2. USDC — the wallet must hold at least the requested bridge amount.
//
// Failure copy names the asset, the chain, and the minimum, e.g.
// "Insufficient ETH for gas on Arbitrum Sepolia — you need at least
// 0.0005 ETH to submit the bridge transactions." instead of letting the
// user sign into a stall or a wasted transaction.
//
// Pure + client-safe (no RPC, no wallet access inside): callers supply the
// already-read balances, this module decides. A null balance (read failed)
// fails OPEN — an unprovable balance must never block a possibly-valid
// bridge; the wallet error mapping remains the backstop.

export const MIN_NATIVE_WEI = 500_000_000_000_000n; // 0.0005 native

/** Native asset symbol per source numeric chain id. */
const NATIVE_SYMBOLS: Record<number, string> = {
  421614: 'ETH', // Arbitrum Sepolia
  84532: 'ETH', // Base Sepolia
  11155420: 'ETH', // Optimism Sepolia
  11155111: 'ETH', // Ethereum Sepolia
  80002: 'POL', // Polygon Amoy
};

export function nativeSymbolForChainId(chainId: number): string {
  return NATIVE_SYMBOLS[chainId] ?? 'ETH';
}

/** Exact wei -> trimmed decimal display (no float). */
export function formatNativeWei(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const s = abs.toString().padStart(19, '0');
  const display = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '') || '0';
  return negative ? `-${display}` : display;
}

export type BridgePreflightError = 'INSUFFICIENT_GAS' | 'INSUFFICIENT_USDC';

export interface BridgePreflightInput {
  /** Live native balance in wei, or null when the read failed (fails open). */
  nativeBalanceWei: bigint | null;
  /** Live USDC balance in 6-dec base units, or null when unknown. */
  usdcBalanceUnits: bigint | null;
  /** Requested bridge amount in 6-dec base units. */
  amountUnits: bigint;
  /** Human source-chain label, e.g. 'Arbitrum Sepolia'. */
  sourceLabel: string;
  /** Numeric source chain id (selects the native symbol). */
  sourceChainId: number;
  /** Minimum native wei required (defaults to MIN_NATIVE_WEI). */
  minNativeWei?: bigint;
}

export function checkBridgePreflight(
  input: BridgePreflightInput
): { ok: true } | { ok: false; kind: BridgePreflightError; error: string } {
  const minWei = input.minNativeWei ?? MIN_NATIVE_WEI;
  const symbol = nativeSymbolForChainId(input.sourceChainId);
  if (input.nativeBalanceWei !== null && input.nativeBalanceWei < minWei) {
    return {
      ok: false,
      kind: 'INSUFFICIENT_GAS',
      error:
        `Insufficient ${symbol} for gas on ${input.sourceLabel} — ` +
        `you need at least ${formatNativeWei(minWei)} ${symbol} to submit the bridge transactions.`,
    };
  }
  if (
    input.usdcBalanceUnits !== null &&
    input.amountUnits > input.usdcBalanceUnits
  ) {
    return {
      ok: false,
      kind: 'INSUFFICIENT_USDC',
      error: `Your connected wallet does not have enough USDC on ${input.sourceLabel}.`,
    };
  }
  return { ok: true };
}
