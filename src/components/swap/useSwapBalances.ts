// src/components/swap/useSwapBalances.ts
//
// Parallel USDC + EURC balance hook for Flow Swap. Reuses the existing
// GET /api/consumer/balance?currency= endpoint — no new balance backend.

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SwapSymbol } from './swapCopy';

export interface SwapBalances {
  /** Canonical 6-dec display strings keyed by symbol (null = not loaded). */
  balances: Record<SwapSymbol, string | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSwapBalances(sessionActive: boolean): SwapBalances {
  const [usdc, setUsdc] = useState<string | null>(null);
  const [eurc, setEurc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!sessionActive) {
      setUsdc(null);
      setEurc(null);
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
    Promise.all([load('USDC'), load('EURC')])
      .then(([u, e]) => {
        if (cancelled) return;
        setUsdc(u);
        setEurc(e);
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

  return { balances: { USDC: usdc, EURC: eurc }, loading, error, refresh };
}
