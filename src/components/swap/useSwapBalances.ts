// src/components/swap/useSwapBalances.ts
//
// Parallel USDC + EURC + cirBTC balance hook for Flow Swap. Reuses the
// existing GET /api/consumer/balance?currency= endpoint — no new balance
// backend (the route already resolves every supported token canonically).

'use client';

import { useCallback, useEffect, useState } from 'react';
import { SWAP_SYMBOLS, type SwapSymbol } from './swapCopy';

export interface SwapBalances {
  /** Display strings keyed by symbol (null = not loaded). */
  balances: Record<SwapSymbol, string | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSwapBalances(sessionActive: boolean): SwapBalances {
  const [values, setValues] = useState<Record<SwapSymbol, string | null>>({
    USDC: null,
    EURC: null,
    CIRBTC: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!sessionActive) {
      setValues({ USDC: null, EURC: null, CIRBTC: null });
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async (currency: SwapSymbol): Promise<string | null> => {
      const res = await fetch(`/api/consumer/balance?currency=${currency}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Could not load ${currency} balance.`);
      }
      return typeof data.balance === 'string' ? data.balance : String(data.balance ?? '');
    };
    Promise.all(SWAP_SYMBOLS.map((s) => load(s)))
      .then((loaded) => {
        if (cancelled) return;
        const next = { USDC: null, EURC: null, CIRBTC: null } as Record<SwapSymbol, string | null>;
        SWAP_SYMBOLS.forEach((s, i) => {
          next[s] = loaded[i] ?? null;
        });
        setValues(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load balances.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionActive, tick]);

  return { balances: values, loading, error, refresh };
}
