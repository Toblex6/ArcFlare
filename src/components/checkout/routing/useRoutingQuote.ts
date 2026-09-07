// src/components/checkout/routing/useRoutingQuote.ts
//
// Quote lifecycle hook for the checkout wallet tab (Payment Routing
// Phase 6). Owns fetching POST /api/payments/quote, the live expiry
// countdown, and re-quote:
//
//   direct     — pay token == settlement token (or the server answers
//                { converted: false }): no conversion, existing direct
//                flow stays available.
//   loading    — quote in flight.
//   ready      — live quote + secondsLeft ticking every second.
//   refreshing — the quote expired naturally; a fresh one is being fetched
//                automatically (recoverable re-quote, nothing charged).
//   error      — fetch failed; the panel offers a manual retry.
//
// Only { reference, payToken } (symbol) is ever sent — rates, outputs,
// venues, and addresses are server-determined. One in-flight request at a
// time (AbortController); reset on pay-token change.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyQuoteError } from './routingCopy';
import { toQuoteViewModel, type QuoteViewModel, type ServerQuote } from './quoteView';
import type { SupportedCurrency } from '@/src/lib/tokens/clientTokens';

export type RoutingQuoteStatus = 'direct' | 'loading' | 'ready' | 'refreshing' | 'error';

export interface RoutingQuoteState {
  status: RoutingQuoteStatus;
  /** Live converted quote (ready only). */
  quote: QuoteViewModel | null;
  /** Raw server quote (ready only) — drives the on-chain execution call. */
  raw: ServerQuote | null;
  secondsLeft: number;
  headline: string | null;
  rawError: string | null;
}

const INITIAL: RoutingQuoteState = {
  status: 'direct',
  quote: null,
  raw: null,
  secondsLeft: 0,
  headline: null,
  rawError: null,
};

export function useRoutingQuote(
  reference: string | undefined,
  paySymbol: SupportedCurrency | null,
  settlementSymbol: SupportedCurrency,
  active: boolean
): RoutingQuoteState & { refresh: () => void } {
  const [state, setState] = useState<RoutingQuoteState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const autoRef = useRef(false);

  const fetchQuote = useCallback(
    async (opts?: { refreshing?: boolean }) => {
      if (!reference || !paySymbol) {
        setState(INITIAL);
        return;
      }
      // Same-token path: no conversion — the direct flow stays available.
      if (paySymbol === settlementSymbol) {
        abortRef.current?.abort();
        setState(INITIAL);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({
        ...s,
        status: opts?.refreshing ? 'refreshing' : 'loading',
        headline: null,
        rawError: null,
      }));
      try {
        const res = await fetch('/api/payments/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference, payToken: paySymbol }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => null)) as ServerQuote & { error?: string } | null;
        if (controller.signal.aborted) return;
        if (!res.ok || !data || (data as ServerQuote).success !== true) {
          const { headline, raw } = friendlyQuoteError((data as { error?: string } | null)?.error);
          setState({ status: 'error', quote: null, raw: null, secondsLeft: 0, headline, rawError: raw });
          return;
        }
        if (!data.converted) {
          // Server confirms same-token: direct path.
          setState(INITIAL);
          return;
        }
        const view = toQuoteViewModel(data as ServerQuote);
        setState({
          status: 'ready',
          quote: view,
          raw: data as ServerQuote,
          secondsLeft: Math.max(0, Math.floor((view.expiresAtMs - Date.now()) / 1000)),
          headline: null,
          rawError: null,
        });
      } catch (err: any) {
        if (controller.signal.aborted) return;
        const { headline, raw } = friendlyQuoteError(err?.message);
        setState({ status: 'error', quote: null, raw: null, secondsLeft: 0, headline, rawError: raw });
      }
    },
    [reference, paySymbol, settlementSymbol]
  );

  const refresh = useCallback(() => {
    autoRef.current = false;
    void fetchQuote();
  }, [fetchQuote]);

  // (Re)fetch when the selection, invoice, or tab activity changes.
  useEffect(() => {
    if (!active) return;
    autoRef.current = false;
    void fetchQuote();
    return () => abortRef.current?.abort();
  }, [active, fetchQuote]);

  // Live countdown; natural expiry triggers one automatic re-quote.
  useEffect(() => {
    if (state.status !== 'ready' || !state.quote) return;
    if (state.secondsLeft > 0) {
      const timer = setTimeout(
        () => setState((s) => (s.status === 'ready' ? { ...s, secondsLeft: s.secondsLeft - 1 } : s)),
        1000
      );
      return () => clearTimeout(timer);
    }
    if (!autoRef.current) {
      autoRef.current = true;
      void fetchQuote({ refreshing: true });
    } else {
      // Auto re-quote already attempted and the fresh quote is somehow
      // already stale — surface the manual path instead of looping.
      setState((s) => (s.status === 'ready' ? { ...s, status: 'error' as const, headline: 'Quote expired — get a fresh quote to continue.', rawError: null } : s));
    }
  }, [state.status, state.secondsLeft, state.quote, fetchQuote]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { ...state, refresh };
}
