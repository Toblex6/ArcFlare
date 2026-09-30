// src/components/swap/useSwapBalances.ts
//
// Parallel per-token balance hook for Flow Swap. Reuses the existing
// GET /api/consumer/balance?currency= endpoint — no new balance backend
// (the route already resolves every supported token canonically).
//
// ISOLATION RULE: every token loads independently (all-settled semantics).
// One token's failure marks ONLY that token — it never clears or blocks the
// others. The global `error` is set only when EVERY requested token failed;
// otherwise per-token failures surface in `errors` for chip-level display.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { SWAP_SYMBOLS, type SwapSymbol } from './swapCopy';

export interface SwapBalances {
  /** Display strings keyed by symbol (null = not loaded / failed). */
  balances: Record<SwapSymbol, string | null>;
  /** Per-token failure reason (null = loaded or not requested). */
  errors: Record<SwapSymbol, string | null>;
  loading: boolean;
  /** Set only when every requested token failed (or the session is dead). */
  error: string | null;
  refresh: () => void;
}

const EMPTY: Record<SwapSymbol, string | null> = { USDC: null, EURC: null, CIRBTC: null };

export function useSwapBalances(
  sessionActive: boolean,
  symbols: readonly SwapSymbol[] = SWAP_SYMBOLS
): SwapBalances {
  const [values, setValues] = useState<Record<SwapSymbol, string | null>>({ ...EMPTY });
  const [errors, setErrors] = useState<Record<SwapSymbol, string | null>>({ ...EMPTY });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const symbolsKey = [...symbols].sort().join(',');

  useEffect(() => {
    const wanted = symbolsKey.split(',').filter(Boolean) as SwapSymbol[];
    if (!sessionActive) {
      setValues({ ...EMPTY });
      setErrors({ ...EMPTY });
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async (currency: SwapSymbol): Promise<string> => {
      const res = await fetch(`/api/consumer/balance?currency=${currency}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        // A clean not-supported answer is terminal for this token (no
        // retry storm): surface it as this token's error only.
        throw new Error(data?.error || `Could not load ${currency} balance.`);
      }
      const v = typeof data.balance === 'string' ? data.balance : String(data.balance ?? '');
      if (v.trim() === '') throw new Error(`Could not load ${currency} balance.`);
      return v;
    };
    // All-settled: each token settles on its own; one rejection never
    // touches the others.
    Promise.all(
      wanted.map(async (s) => {
        try {
          return { s, value: await load(s), error: null as string | null };
        } catch (err: unknown) {
          return { s, value: null as string | null, error: err instanceof Error ? err.message : 'Could not load balances.' };
        }
      })
    ).then((settled) => {
      if (cancelled) return;
      const next = { ...EMPTY };
      const nextErrors = { ...EMPTY };
      for (const r of settled) {
        next[r.s] = r.value;
        nextErrors[r.s] = r.error;
      }
      setValues(next);
      setErrors(nextErrors);
      const failures = settled.filter((r) => r.value === null);
      setError(
        failures.length > 0 && failures.length === settled.length
          ? (failures[0]?.error ?? 'Could not load balances.')
          : null
      );
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, tick, symbolsKey]);

  return { balances: values, errors, loading, error, refresh };
}
