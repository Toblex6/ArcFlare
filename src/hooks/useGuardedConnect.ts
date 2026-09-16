'use client';

// src/hooks/useGuardedConnect.ts
//
// Shared WalletConnect double-fire guard.
//
// Background: every wallet-connect call site used to guard re-entry with
// React state only (`connecting` / `isConnecting` + `disabled={busy}`).
// State updates are asynchronous, so a second tap / duplicate click event /
// fast double-invocation fired wagmi's `connectAsync()` again before the
// first render committed. That spun up a SECOND WalletConnect pairing
// session in parallel (two relay.walletconnect.org websockets); the modal
// then listened to the display_uri of a stale/superseded session, leaving
// the sheet stuck loading with a greyed-out "Open" button.
//
// Fix: a synchronous lock (`useRef<boolean>`) checked AND set in the same
// tick as the click, before `connectAsync` is called, released in `finally`.
// A ref — not state — is the only thing that closes the gap, because refs
// mutate synchronously without waiting for a re-render.
//
// All wallet-connect call sites must use this hook instead of calling
// wagmi's `useConnect()` + a locally-defined `handleConnect` with only a
// state-based guard.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnect } from 'wagmi';
import { dedupeConnectors, withTimeout } from '@/lib/wallet/walletLabels';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';

// Same deadline the call sites historically used for a wallet handshake.
export const GUARDED_CONNECT_TIMEOUT_MS = 45000;

// Minimal structural type for a wagmi connector — enough to classify and
// pass through to wagmi without coupling this hook to a wagmi version.
export interface GuardedConnector {
  uid: string;
  id?: string;
  type?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Pure, framework-free guard primitive.
//
// The hook below is a thin React wrapper over this. Extracting the lock
// keeps the race itself unit-testable without React/wagmi: call the returned
// `invoke` twice synchronously (no await between calls) and the underlying
// `fn` must run exactly once.
// ---------------------------------------------------------------------------
export function createGuardedInvoker() {
  let locked = false;
  return async function invoke<T>(fn: () => Promise<T>, isPending: boolean): Promise<T | undefined> {
    // Synchronous check-and-set in the same tick — before any await or
    // state update. A second synchronous call sees `locked === true` and
    // no-ops instead of spinning up a second WalletConnect session.
    if (locked || isPending) return undefined;
    locked = true;
    try {
      return await fn();
    } finally {
      locked = false;
    }
  };
}

export interface UseGuardedConnectOptions {
  /** Handshake deadline; defaults to GUARDED_CONNECT_TIMEOUT_MS (45s). */
  timeoutMs?: number;
}

export function useGuardedConnect(options?: UseGuardedConnectOptions) {
  const timeoutMs = options?.timeoutMs ?? GUARDED_CONNECT_TIMEOUT_MS;
  const { connectors, connect, connectAsync, isPending, error: connectError, reset } = useConnect();

  // Synchronous double-fire lock. Checked AND set in the same tick as the
  // click, before any await — this is the entire fix. Never replace with
  // useState: state updates commit asynchronously, which is the bug.
  const lockRef = useRef(false);
  // Ref mirror of wagmi's async pending flag so the guard sees a stable
  // synchronous value even when the callback closure is stale.
  const pendingRef = useRef(isPending);
  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);

  // Hook-owned in-flight state (replaces each call site's local
  // `connecting` useState that duplicated this).
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Surface wagmi's own async connect errors through the same friendly
  // copy the call sites already render, without changing their display.
  useEffect(() => {
    if (connectError) setError(friendlyWalletError(connectError));
  }, [connectError]);

  // Guarded async connect. Applies the historic withTimeout deadline,
  // records a friendly error, rethrows so call-site catch blocks (and any
  // post-connect work like challenge/sign/redirect) keep their exact
  // Guarded async connect. Applies the historic withTimeout deadline,
  // records a friendly error, rethrows so call-site catch blocks (and any
  // post-connect work like challenge/sign/redirect) keep their exact
  // behavior. Resolves `undefined` ONLY when the call was suppressed as a
  // double-fire — callers with post-connect work must treat `undefined` as
  // "another attempt is already in flight; do nothing".
  //
  // The connector parameter is intentionally structural (`{ uid: string }`
  // + passthrough): wagmi's Connector type varies across versions, and the
  // hook never reads anything except identity fields for classification.
  // Parameters are `any` deliberately: wagmi's Connector generics vary, and
  // the hook's value is the runtime lock, not the parameter type. (Repo
  // convention leans on `as any` at such version boundaries.)
  const connectAsyncGuarded = useCallback(
    async (connector: any): Promise<any> => {
      if (lockRef.current || pendingRef.current) return undefined;
      lockRef.current = true;
      setConnecting(true);
      setError(null);
      try {
        const raw = connectAsync as unknown as ((args: any) => Promise<any>) | undefined;
        if (!raw) throw new Error('Wallet connector unavailable.');
        return await withTimeout(raw({ connector }), timeoutMs, 'Wallet connection timed out');
      } catch (err: unknown) {
        setError(friendlyWalletError(err));
        throw err;
      } finally {
        lockRef.current = false;
        setConnecting(false);
      }
    },
    [connectAsync, timeoutMs]
  );

  // Guarded sync fallback for the legacy `connect({ connector })` path
  // (used defensively where `connectAsync` may be absent). Same lock.
  const connectGuarded = useCallback(
    (connector: any): void => {
      if (lockRef.current || pendingRef.current) return;
      lockRef.current = true;
      try {
        (connect as any)?.({ connector });
      } finally {
        // Sync `connect` returns void (result arrives via wagmi state), so
        // release on the next microtask — still late enough to swallow a
        // same-tick double-fire, early enough not to block a real retry.
        queueMicrotask(() => {
          lockRef.current = false;
        });
      }
    },
    [connect]
  );

  // Prefers async (timeout + result + error propagation), falls back to
  // sync — matches the `connectAsync ? connectAsync : connect` defensive
  // pattern the escrow pages used.
  const connectWithFallback = useCallback(
    async (connector: any): Promise<any> => {
      const raw = connectAsync as unknown as ((args: any) => Promise<any>) | undefined;
      if (raw) return connectAsyncGuarded(connector);
      connectGuarded(connector);
      return undefined;
    },
    [connectAsync, connectAsyncGuarded, connectGuarded]
  );

  const resetGuarded = useCallback(() => {
    setError(null);
    reset?.();
  }, [reset]);

  // Memoized once per connectors-identity change. Several call sites
  // recomputed `dedupeConnectors(connectors)` inline on EVERY render
  // (including inside render-time IIFEs); the helper itself is unchanged —
  // only the needless recomputation is removed. `dedupeConnectors` is pure
  // over connector identity, so memoizing on `connectors` is exact.
  const dedupedConnectors = useMemo(() => dedupeConnectors<any>(connectors as any), [connectors]);
  const injectedConnectors = useMemo(() => dedupedConnectors.filter((c) => c.type === 'injected'), [dedupedConnectors]);
  const walletConnectConnector = useMemo(
    () => dedupedConnectors.find((c) => c.type === 'walletConnect'),
    [dedupedConnectors]
  );
  const otherConnectors = useMemo(
    () => dedupedConnectors.filter((c) => c.type !== 'injected' && c.type !== 'walletConnect'),
    [dedupedConnectors]
  );

  return {
    connectors: connectors as unknown as GuardedConnector[],
    dedupedConnectors,
    injectedConnectors,
    walletConnectConnector,
    otherConnectors,
    /** Guarded async connect (primary). `undefined` return = suppressed double-fire. */
    connectAsync: connectAsyncGuarded,
    /** Guarded sync connect (legacy fallback path only). */
    connect: connectGuarded,
    /** Async-preferred, sync-fallback — for the escrow defensive pattern. */
    connectWithFallback,
    /** Hook-owned in-flight flag (replaces local `connecting` state). */
    connecting,
    /** wagmi's own pending flag, passed through. */
    isConnecting: isPending,
    /** `connecting || isConnecting` — drop-in for each site's `busy`/`isBusy`. */
    busy: connecting || isPending,
    /** Friendly error from the last guarded attempt (plus wagmi async errors). */
    error,
    setError,
    clearError: () => setError(null),
    /** Raw wagmi connect error (for sites rendering `friendlyWalletError(connectError)`). */
    connectError,
    reset: resetGuarded,
  };
}

export type GuardedConnect = ReturnType<typeof useGuardedConnect>;
