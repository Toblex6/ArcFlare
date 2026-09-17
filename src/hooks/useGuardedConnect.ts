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
//
// Prompt 7 diagnosis (2026-09-16, device-verified failure of the per-click
// guard alone — one tap still opened 5 relay sockets, "Open" greyed out):
//   - The `lockRef` below guards re-entry within a SINGLE hook instance
//     only. Co-mounted instances each own an independent lock: on
//     /consumer the page-level picker (`consumer/page.tsx`) and
//     `FlowSwapView` (mounted when view === "swap") are live at the same
//     time, and the picker + wallet-switch modals can overlay the page's
//     own connect UI. A tap on a second surface while another instance's
//     attempt is in flight opened a second session. Hence the module-level
//     global lock further below — one connect attempt app-wide at a time.
//   - No auto-reconnect race exists in this tree: `WagmiProvider` (wagmi
//     v3) takes no `reconnectOnMount` prop, and no file under src calls
//     `useReconnect`/`reconnect()` (verified by sweep). The
//     ethereum-provider's `loadPersistedSession` restores accounts from an
//     existing session but never starts a new pairing, so a fresh load has
//     no competing auto-attempt.
//   - At the wagmi layer one guarded proceed equals exactly one
//     `connector.connect()` (`@wagmi/core` `connect()` has no fan-out or
//     retry). Any residual one-tap→N-socket fan-out therefore lives below
//     wagmi (ethereum-provider 2.23.10 + transitive @reown/appkit modal),
//     which this repo pins (no upgrades per policy). The flag-gated debug
//     log below exists so a device retest can attribute each proceeding
//     call (call ID + instance ID + stack) instead of guessing.

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
  /** EIP-6963 announced wallet icon (wagmi v3 exposes it; may be absent). */
  icon?: string;
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

// ---------------------------------------------------------------------------
// App-wide connect-attempt lock (Prompt 7 fix).
//
// `createGuardedInvoker` / `lockRef` guard re-entry within ONE hook
// instance. Every mounted `useGuardedConnect` owns its own ref, so two
// co-mounted connect surfaces (page picker + FlowSwapView, picker +
// wallet-switch modal) could each proceed once — two sessions from what
// the user experiences as one flow. This module-level guard is shared by
// ALL instances: the check-and-set is still synchronous in the click tick,
// exactly like the per-instance lock, so it closes the cross-instance gap
// with no behavior change for the single-instance case.
//
// Factored as a tiny pure factory (same style as createGuardedInvoker) so
// the cross-instance property is unit-testable without React/wagmi: two
// invokers sharing one guard, invoked synchronously, run the underlying
// connect exactly once. The hook below uses the module singleton.
// ---------------------------------------------------------------------------
export function createGlobalConnectGuard() {
  let inFlight = false;
  return {
    /** Synchronously try to claim the app-wide attempt slot. */
    tryAcquire: (): boolean => {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    /** Release the slot. Always called in `finally`. */
    release: (): void => {
      inFlight = false;
    },
    /** Test/observability accessor — never used for control flow. */
    isInFlight: (): boolean => inFlight,
  };
}

export type GlobalConnectGuard = ReturnType<typeof createGlobalConnectGuard>;

/** The single app-wide slot. Module state — shared across all hook instances. */
const globalConnectGuard = createGlobalConnectGuard();

// ---------------------------------------------------------------------------
// Device-retest instrumentation (Prompt 7, step 1).
//
// Off by default (no prod log spam, no PII — IDs and stacks only). Enable
// with NEXT_PUBLIC_WC_CONNECT_DEBUG=1, then on the device: fresh load, one
// tap, and read the `console.debug` lines. Each line that "proceeds" past
// BOTH locks corresponds to exactly one wagmi `connectAsync` → exactly one
// WalletConnect pairing at the wagmi layer, so the count of "proceeds"
// lines tells you whether N relay sockets came from N app-level attempts
// (with attributing instance IDs + stacks) or from below wagmi.
// ---------------------------------------------------------------------------
const WC_CONNECT_DEBUG =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WC_CONNECT_DEBUG === '1';

function wcDebug(...args: unknown[]) {
  if (WC_CONNECT_DEBUG && typeof console !== 'undefined' && typeof console.debug === 'function') {
    console.debug('[guarded-connect]', ...args);
  }
}

let guardedConnectInstanceCounter = 0;
let guardedConnectCallCounter = 0;

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
  // Instance ID for the device-retest instrumentation only (which mounted
  // surface proceeded vs. was suppressed). Never used for control flow.
  const instanceIdRef = useRef<number>(0);
  if (instanceIdRef.current === 0) {
    guardedConnectInstanceCounter += 1;
    instanceIdRef.current = guardedConnectInstanceCounter;
  }
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
      guardedConnectCallCounter += 1;
      const callId = guardedConnectCallCounter;
      const instanceId = instanceIdRef.current;
      if (lockRef.current || pendingRef.current || !globalConnectGuard.tryAcquire()) {
        wcDebug(
          `call#${callId} instance#${instanceId} suppressed ` +
            `(perInstanceLocked=${lockRef.current} wagmiPending=${pendingRef.current} ` +
            `globalInFlight=${globalConnectGuard.isInFlight()})`,
          new Error('suppressed-trace').stack
        );
        return undefined;
      }
      lockRef.current = true;
      wcDebug(`call#${callId} instance#${instanceId} proceeds`, new Error('proceed-trace').stack);
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
        globalConnectGuard.release();
        setConnecting(false);
      }
    },
    [connectAsync, timeoutMs]
  );

  // Guarded sync fallback for the legacy `connect({ connector })` path
  // (used defensively where `connectAsync` may be absent). Same locks —
  // per-instance AND app-wide — as the async path.
  const connectGuarded = useCallback(
    (connector: any): void => {
      if (lockRef.current || pendingRef.current || !globalConnectGuard.tryAcquire()) return;
      lockRef.current = true;
      try {
        (connect as any)?.({ connector });
      } finally {
        // Sync `connect` returns void (result arrives via wagmi state), so
        // release on the next microtask — still late enough to swallow a
        // same-tick double-fire, early enough not to block a real retry.
        // The global slot releases on the same microtask so a second
        // instance's same-tick attempt is suppressed too.
        queueMicrotask(() => {
          lockRef.current = false;
          globalConnectGuard.release();
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
