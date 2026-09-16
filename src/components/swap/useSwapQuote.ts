// src/components/swap/useSwapQuote.ts
//
// Quote lifecycle hook for Flow Swap. Owns fetching POST /api/swap/quote,
// the live expiry countdown, and re-quote:
//
//   idle       — no valid amount/pair yet (or pair needs two tokens).
//   loading    — quote in flight (no usable quote yet).
//   quoted     — live quote + secondsLeft ticking every second.
//   expired    — past expiry and the automatic re-quote did not recover;
//                the panel offers a manual refresh.
//   error      — fetch failed; the panel offers a manual retry.
//
// Only { inputSymbol, outputSymbol, amount } (symbols + decimal string) is
// ever sent — routing, pools, fees, recipients, and unsigned transactions
// are server-determined. One in-flight request at a time (AbortController).
// Requests are debounced so typing never hammers the endpoint; natural
// expiry triggers one automatic re-quote before surfacing `expired`.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { canonicalDecimals, displaySymbol, formatSwapLeg, friendlySwapError, type SwapSymbol } from './swapCopy';

export interface SwapUnsignedTx {
  to: string;
  data: `0x${string}`;
  value: string;
  label: string;
}

export interface SwapQuote {
  intentId: string;
  quoteHash: string;
  input: { symbol: SwapSymbol; amount: string; amountDisplay: string };
  output: { symbol: SwapSymbol; quoted: string; minOut: string };
  quoteExpiresAt: string;
  expiresAtMs: number;
  unsigned: { approvals: SwapUnsignedTx[]; wrapTx: SwapUnsignedTx | null; swapTx: SwapUnsignedTx };
  slippageBps: number;
}

export interface SwapQuoteView extends SwapQuote {
  quotedDisplay: string;
  minOutDisplay: string;
  rateDisplay: string;
  /** Execution venue id as returned by the backend (e.g. 'unitflow-v3'). */
  venueId: string | null;
  /** Deployment family name bound into the quote (informational). */
  deploymentName: string | null;
  /**
   * Informational Tower rate-discovery candidate. Tower is quote/discovery
   * only — it never executes. Absent when the flag is off or unavailable.
   */
  tower: {
    consulted: boolean;
    available: boolean;
    quotedOutput?: string;
    minOut?: string;
    note: string;
  } | null;
}

export type SwapQuoteStatus = 'idle' | 'loading' | 'quoted' | 'expired' | 'error';

export interface SwapQuoteState {
  status: SwapQuoteStatus;
  /** Live quote (quoted only; retained while an auto-refresh is in flight). */
  quote: SwapQuoteView | null;
  secondsLeft: number;
  headline: string | null;
  /** Raw server message for the technical-details surface (never the headline). */
  rawError: string | null;
  /** True while the automatic expiry re-quote is in flight. */
  refreshing: boolean;
}

const INITIAL: SwapQuoteState = {
  status: 'idle',
  quote: null,
  secondsLeft: 0,
  headline: null,
  rawError: null,
  refreshing: false,
};

const DEBOUNCE_MS = 600;

function toViewModel(data: Record<string, unknown>): SwapQuoteView {
  const input = data.input as SwapQuote['input'];
  const output = data.output as SwapQuote['output'];
  const unsigned = data.unsigned as SwapQuote['unsigned'];
  if (!input?.symbol || !output?.symbol || !unsigned?.swapTx) {
    throw new Error('Quote response malformed.');
  }
  const quoteExpiresAt = String(data.quoteExpiresAt ?? '');
  const expiresAtMs = new Date(quoteExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) throw new Error('Quote is missing an expiry.');
  const quotedDisplay = formatSwapLeg(output.quoted, output.symbol as SwapSymbol);
  const minOutDisplay = formatSwapLeg(output.minOut, output.symbol as SwapSymbol);
  let rateDisplay = `1 ${displaySymbol(input.symbol as SwapSymbol)} ≈ ? ${displaySymbol(output.symbol as SwapSymbol)}`;
  const inNum = Number(input.amountDisplay);
  const outNum = Number(quotedDisplay);
  if (Number.isFinite(inNum) && Number.isFinite(outNum) && inNum > 0) {
    const rate = outNum / inNum;
    const formatted = rate >= 100 ? rate.toFixed(2) : rate >= 1 ? rate.toFixed(4) : rate.toPrecision(4);
    rateDisplay = `1 ${displaySymbol(input.symbol as SwapSymbol)} ≈ ${formatted} ${displaySymbol(output.symbol as SwapSymbol)}`;
  }
  const venueId = typeof data.venueId === 'string' && data.venueId.trim() !== '' ? data.venueId : null;
  const deploymentName = typeof data.deploymentName === 'string' && data.deploymentName.trim() !== '' ? data.deploymentName : null;
  const rawTower = data.tower as SwapQuoteView['tower'];
  const tower = rawTower && typeof rawTower === 'object' && typeof rawTower.consulted === 'boolean' ? rawTower : null;
  return {
    intentId: String(data.intentId ?? ''),
    quoteHash: String(data.quoteHash ?? ''),
    input,
    output,
    quoteExpiresAt,
    expiresAtMs,
    unsigned: {
      approvals: Array.isArray(unsigned.approvals) ? unsigned.approvals : [],
      wrapTx: unsigned.wrapTx ?? null,
      swapTx: unsigned.swapTx,
    },
    slippageBps: typeof data.slippageBps === 'number' ? data.slippageBps : 100,
    quotedDisplay,
    minOutDisplay,
    rateDisplay,
    venueId,
    deploymentName,
    tower,
  };
}

export function useSwapQuote(
  inputSymbol: SwapSymbol,
  outputSymbol: SwapSymbol,
  amount: string,
  active: boolean
): SwapQuoteState & { refresh: () => void } {
  const [state, setState] = useState<SwapQuoteState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const autoRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const amountKey = amount.trim();
  const pairValid = inputSymbol !== outputSymbol;
  // Token-native precision: up to 6 decimals for USDC/EURC, 8 for cirBTC.
  const inputDecimals = canonicalDecimals(inputSymbol);
  const amountLooksValid =
    new RegExp(`^\\d+(\\.\\d{1,${inputDecimals}})?$`).test(amountKey) && parseFloat(amountKey) > 0;

  const fetchQuote = useCallback(
    async (opts?: { refreshing?: boolean }) => {
      if (!pairValid || !amountLooksValid) {
        setState(INITIAL);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({
        ...s,
        status: opts?.refreshing ? s.status : 'loading',
        refreshing: !!opts?.refreshing,
        headline: null,
        rawError: null,
        ...(opts?.refreshing ? {} : { quote: null, secondsLeft: 0 }),
      }));
      try {
        const res = await fetch('/api/swap/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputSymbol, outputSymbol, amount: amountKey }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => null)) as (Record<string, unknown> & {
          success?: boolean;
          error?: string;
        }) | null;
        if (controller.signal.aborted) return;
        if (!res.ok || !data || data.success !== true) {
          const { headline, raw } = friendlySwapError(data?.error);
          setState((s) => ({
            ...s,
            status: res.status === 410 ? 'expired' : 'error',
            quote: opts?.refreshing ? s.quote : null,
            secondsLeft: 0,
            headline,
            rawError: raw,
            refreshing: false,
          }));
          return;
        }
        const view = toViewModel(data);
        autoRef.current = false;
        setState({
          status: 'quoted',
          quote: view,
          secondsLeft: Math.max(0, Math.floor((view.expiresAtMs - Date.now()) / 1000)),
          headline: null,
          rawError: null,
          refreshing: false,
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err ?? '');
        const { headline, raw } = friendlySwapError(message);
        setState((s) => ({
          ...s,
          status: 'error',
          quote: opts?.refreshing ? s.quote : null,
          secondsLeft: 0,
          headline,
          rawError: raw,
          refreshing: false,
        }));
      }
    },
    [amountKey, amountLooksValid, inputSymbol, outputSymbol, pairValid]
  );

  const refresh = useCallback(() => {
    autoRef.current = false;
    void fetchQuote();
  }, [fetchQuote]);

  // Debounced (re)fetch when the pair, amount, or tab activity changes.
  useEffect(() => {
    if (!active) return;
    autoRef.current = false;
    if (!pairValid || !amountLooksValid) {
      abortRef.current?.abort();
      setState(INITIAL);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchQuote();
    }, DEBOUNCE_MS);
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [active, fetchQuote, pairValid, amountLooksValid]);

  // Live countdown; natural expiry triggers one automatic re-quote.
  useEffect(() => {
    if (state.status !== 'quoted' || !state.quote) return;
    if (state.refreshing) return;
    if (state.secondsLeft > 0) {
      const timer = setTimeout(
        () => setState((s) => (s.status === 'quoted' ? { ...s, secondsLeft: s.secondsLeft - 1 } : s)),
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
      const { headline, raw } = friendlySwapError('Swap quote expired before execution.');
      setState((s) => ({ ...s, status: 'expired', headline, rawError: raw, refreshing: false }));
    }
  }, [state.status, state.secondsLeft, state.quote, state.refreshing, fetchQuote]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  return { ...state, refresh };
}
