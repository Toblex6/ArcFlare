// src/lib/payments/chainFilter.ts
//
// Production-view filtering for historical testnet records.
//
// PaymentLog.chain is a free-text display string (e.g. "Arc v1.0",
// "Arc Testnet v1.0", "ARC-TESTNET", "Arc Testnet (On-chain Transfer)") —
// there is no structured chainId column. When the server runs mainnet,
// production views (merchant dashboard, payment lists) must NOT show
// testnet-era rows as current activity/balances.
//
// Rules:
//   - NOTHING is ever deleted or mutated: rows are preserved in the database
//     and remain fully visible whenever the server runs testnet.
//   - On mainnet, rows whose stored chain value indicates a test network are
//     excluded from lists AND from aggregate metrics (volumes, counts).
//   - Display fallbacks for a missing chain value are production-safe ("Arc").

import { getArcNetworkName } from '@/lib/config/network';

/** True when a stored free-text chain value indicates a test network. */
export function isTestnetChainValue(chain: unknown): boolean {
  const s = String(chain ?? '').trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes('testnet') ||
    s.includes('sepolia') ||
    s.includes('amoy') ||
    s === 'arc-testnet' ||
    s === 'arc_testnet'
  );
}

/**
 * Filter rows for the CURRENT server network view. On mainnet, testnet-chain
 * rows are excluded (preserved in DB, hidden from production views). On
 * testnet everything passes through unchanged.
 */
export function filterRowsForNetwork<T extends { chain?: unknown }>(
  rows: readonly T[],
  networkName?: string
): T[] {
  const name = networkName ?? getArcNetworkName();
  if (name !== 'mainnet') return [...rows];
  return rows.filter((r) => !isTestnetChainValue((r as any)?.chain));
}

/** Production-safe display fallback for a missing stored chain value. */
export function productionChainFallback(): string {
  return 'Arc';
}
