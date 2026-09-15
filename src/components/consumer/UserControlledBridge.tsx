// src/components/consumer/UserControlledBridge.tsx
//
// 'use client' — browser-side CCTP bridge orchestration for Circle
// USER_CONTROLLED wallets (server-orchestrated, browser-executed burn).
//
// Flow: the server builds every byte of calldata and creates Circle
// challenges (POST /api/cctp/transfer with a per-request userToken); this
// component EXECUTES each challengeId through the Web SDK
// (setAuthentication -> execute), then advances the flow via
// POST /api/cctp/transfer/challenge, and finally polls
// GET /api/cctp/transfer/status until the Arc mint lands.
//
// Circle credentials (userToken/encryptionKey) live in the shared
// CircleSessionProvider at the consumer page level (memory-only React
// state — never localStorage, never cookies) so Swap/Save/Bridge/etc.
// reuse an already-valid session within the same visit instead of each
// forcing Google/email re-auth. Re-auth happens only when the shared
// session is actually missing or expired — expiry is detected by Circle's
// own API signals (SDK error 155104 "userTokenExpired" or server-side
// 401/CIRCLE_AUTH_EXPIRED), never by a client-side timer.
//
// Secrets discipline mirrors CircleUserWallet.tsx: only short-lived
// device-bound tokens touch sessionStorage (for the OAuth redirect
// bridge), never user credentials. userToken is passed per-request in the
// POST body and never logged.

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCircleSession } from './CircleSessionContext';

export interface BridgeChainOption {
  id: string;
  label: string;
  testnet?: boolean;
}

type Phase =
  | 'idle'
  | 'auth'
  | 'preparing'
  | 'signing'
  | 'continuing'
  | 'minting'
  | 'done';

const PENDING_KEY = 'flarehq-circle-pending-login';
const PENDING_BRIDGE_KEY = 'flarehq-bridge-pending';

async function circleProxy(body: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/consumer/circle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.success) {
    const err = new Error(data?.error || `Circle request failed (${res.status}).`) as any;
    err.code = data?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function friendlyError(e: any): string {
  const code = String(e?.code ?? '');
  if (code === 'USER_TOKEN_REQUIRED') {
    return 'Your Circle sign-in expired — sign in again and retry the bridge.';
  }
  if (code === 'WALLET_NOT_ON_CHAIN') {
    return 'Your wallet needs activating on the source chain first — approve the Circle prompt, then retry.';
  }
  if (code === 'INSUFFICIENT_BALANCE') {
    return e?.message || 'Insufficient USDC on the source chain for this bridge.';
  }
  if (code === 'CHALLENGE_MISMATCH' || code === 'UNKNOWN_REFERENCE') {
    return 'This bridge step expired — start the bridge again.';
  }
  if (code === 'BURN_REVERTED' || code === 'BURN_EVENT_MISMATCH') {
    return 'The burn did not verify on-chain — no funds moved. Try the bridge again.';
  }
  if (e?.status === 503 || code === 'CIRCLE_NOT_CONFIGURED' || code === 'CIRCLE_APP_ID_MISSING') {
    return 'Bridging support for your wallet type is being added - check back soon';
  }
  const msg = String(e?.message ?? '');
  if (/cancel|cancelled|dismiss|popup|user denied|user rejected|access_denied/i.test(msg)) {
    return 'Signing was cancelled in the Circle prompt — nothing moved. Try again when ready.';
  }
  if (/network|fetch|failed|unavailable|502|500/i.test(msg)) {
    return 'Circle is unreachable right now. Check your connection and try again.';
  }
  return msg || 'Bridge failed. Try again.';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UserControlledBridge({
  chains,
  fromChain,
  onFromChainChange,
  toChain,
  walletAddress,
  authPost,
  chainBalance,
  chainBalanceLoading,
  chainBalanceError,
  onRetryBalance,
}: {
  chains: BridgeChainOption[];
  fromChain: string;
  onFromChainChange: (id: string) => void;
  toChain: string;
  walletAddress: string;
  // PIN-aware POST helper for the two CCTP bridge routes
  // ('transfer' → /api/cctp/transfer, 'challenge' →
  // /api/cctp/transfer/challenge): (route, body) => parsed JSON, throws on
  // failure. The page wires this to its protectedFetch (step-up headers).
  authPost: (route: 'transfer' | 'challenge', body: Record<string, unknown>) => Promise<any>;
  chainBalance: string | null;
  chainBalanceLoading: boolean;
  chainBalanceError: string | null;
  onRetryBalance: () => void;
}) {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'google' | 'email'>('google');
  const [result, setResult] = useState<{ ok: boolean; message: string; explorerUrl?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Shared Circle session (page-level): reuse an already-valid login
  // across Bridge/Swap/Save/etc. within the same visit. Only missing or
  // Circle-API-expired sessions force re-auth — never view navigation.
  // The per-challenge setAuthentication -> execute flow below is unchanged.
  const { getUserToken, getEncryptionKey, setSession, clearSession, sdkRef: sharedSdkRef } =
    useCircleSession();
  const cancelledRef = useRef(false);
  const autoResumedRef = useRef(false);

  const fail = useCallback(
    (e: any) => {
      if (cancelledRef.current) return;
      // Circle API says the token is expired: drop the shared session so
      // the next attempt re-auths once. Covers the SDK error code
      // (155104 / userTokenExpired mapped to USER_TOKEN_REQUIRED by the
      // bridge route) and the server-side 401 (CIRCLE_AUTH_EXPIRED from
      // the session-link route's listWallets call).
      const code = String(e?.code ?? '');
      if (
        code === 'USER_TOKEN_REQUIRED' ||
        code === 'CIRCLE_AUTH_EXPIRED' ||
        code === '155104'
      ) clearSession();
      setError(friendlyError(e));
      setStatus(null);
      setBusy(false);
      setPhase('idle');
    },
    [clearSession]
  );

  // Execution SDK shared at the page level: login flows assign it when they
  // construct the SDK; a lazily constructed instance covers the case where
  // the session was seeded elsewhere (e.g. onboarding) and this view never
  // built one. Either way the caller still does setAuthentication per
  // challengeId — the per-transaction challenge flow is unchanged.
  const ensureExecutionSdk = useCallback(async () => {
    if (sharedSdkRef.current) return sharedSdkRef.current;
    const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');
    const sdk = new W3SSdk({ appSettings: { appId } }, () => {});
    sharedSdkRef.current = sdk;
    return sdk;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // ── Challenge execution (browser-only — the SDK is lazy-imported so it
  // is never bundled server-side) ─────────────────────────────────────────
  const executeChallenge = useCallback(
    async (challengeId: string) => {
      const userToken = getUserToken();
      if (!userToken) throw new Error('Circle sign-in expired — sign in again.');
      const sdk = await ensureExecutionSdk();
      sdk.setAuthentication({ userToken, encryptionKey: getEncryptionKey() });
      await new Promise<void>((resolve, reject) => {
        try {
          sdk.execute(challengeId, (err: any) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err?.message ?? err ?? 'Challenge failed.')));
            else resolve();
          });
        } catch (e) {
          reject(e);
        }
      });
    },
    [getUserToken, getEncryptionKey, ensureExecutionSdk]
  );

  const continueBridge = useCallback(
    async (userToken: string, reference: string, challengeId: string): Promise<any> => {
      // Retryable poll of the continue endpoint: executing/confirming are
      // transient (Circle indexing / on-chain confirmation).
      for (let i = 0; i < 40; i++) {
        if (cancelledRef.current) throw new Error('Bridge cancelled.');
        const data = await authPost('challenge', { reference, challengeId, userToken });
        const state = String(data?.state ?? '');
        if (state === 'executing' || state === 'confirming') {
          setStatus(
            state === 'executing'
              ? 'Waiting for your approval in the Circle prompt…'
              : 'Confirming on-chain — this can take a minute…'
          );
          await sleep(5000);
          continue;
        }
        return data;
      }
      throw new Error('The bridge step is taking longer than expected — retry to continue where you left off.');
    },
    [authPost]
  );

  const pollMintStatus = useCallback(async (reference: string): Promise<any> => {
    for (let i = 0; i < 60; i++) {
      if (cancelledRef.current) throw new Error('Bridge cancelled.');
      const res = await fetch(`/api/cctp/transfer/status?reference=${encodeURIComponent(reference)}`);
      const data = await res.json().catch(() => ({}));
      if (data?.success && data?.state === 'success') return data;
      if (data?.success && data?.state === 'error') {
        throw new Error(data?.error || 'Bridge failed.');
      }
      setStatus('Burn verified — waiting for the Arc mint (Circle relayer)…');
      await sleep(10_000);
    }
    throw new Error('The Arc mint is taking longer than expected — check back via the status endpoint.');
  }, []);

  // ── Core orchestration ──────────────────────────────────────────────────
  const runBridge = useCallback(
    async (userToken: string, bridgeAmount: string, bridgeFromChain: string) => {
      setBusy(true);
      setError(null);
      setResult(null);
      setPhase('preparing');
      setStatus('Preparing your bridge…');
      try {
        let data = await authPost('transfer', {
          fromChain: bridgeFromChain,
          toChain,
          amount: bridgeAmount,
          recipient: walletAddress,
          userToken,
        });

        // Provision loop: wallet missing on the source chain → execute the
        // provisioning challenge, then retry initiation (Circle needs a
        // moment to index the new wallet resource).
        for (let p = 0; p < 3 && String(data?.state ?? '') === 'needs-provision'; p++) {
          setPhase('signing');
          setStatus('Activate your wallet on the source chain in the Circle prompt…');
          await executeChallenge(String(data.challengeId));
          await sleep(3000);
          setPhase('preparing');
          setStatus('Retrying the bridge…');
          data = await authPost('transfer', {
            fromChain: bridgeFromChain,
            toChain,
            amount: bridgeAmount,
            recipient: walletAddress,
            userToken,
          });
        }

        const state = String(data?.state ?? '');
        if (state === 'needs-provision') {
          throw new Error('Your wallet is still activating on the source chain — wait a moment and retry the bridge.');
        }

        let reference = String(data?.reference ?? '');
        if (state === 'needs-approval' || state === 'needs-burn') {
          if (!reference || !data?.challengeId) throw new Error('Bridge initiation returned an incomplete step.');
          setPhase('signing');
          setStatus(
            state === 'needs-approval'
              ? 'Approve USDC spending in the Circle prompt…'
              : 'Confirm the bridge burn in the Circle prompt…'
          );
          await executeChallenge(String(data.challengeId));
          setPhase('continuing');
          setStatus('Verifying your signature…');
          const next = await continueBridge(userToken, reference, String(data.challengeId));
          const nextState = String(next?.state ?? '');
          if (nextState === 'needs-burn') {
            reference = String(next?.reference ?? reference);
            if (!next?.challengeId) throw new Error('Bridge approval verified but no burn step was issued.');
            setPhase('signing');
            setStatus('Confirm the bridge burn in the Circle prompt…');
            await executeChallenge(String(next.challengeId));
            setPhase('continuing');
            setStatus('Verifying the burn on-chain…');
            const finalStep = await continueBridge(userToken, reference, String(next.challengeId));
            if (String(finalStep?.state ?? '') !== 'minting') {
              throw new Error(finalStep?.error || 'Burn verification did not complete.');
            }
          } else if (nextState !== 'minting') {
            throw new Error(next?.error || 'Bridge step did not complete.');
          }
        } else if (state !== 'minting') {
          throw new Error(data?.error || 'Bridge initiation failed.');
        }

        // Mint leg: Circle's relayer completes it — poll the balance-delta.
        setPhase('minting');
        const done = await pollMintStatus(reference);
        if (cancelledRef.current) return;
        setPhase('done');
        setBusy(false);
        setStatus(null);
        // Session intentionally retained: the shared login stays valid until
        // Circle's API reports expiry (155104 / 401). Expiry/disconnect
        // clears it — never completion.
        setResult({
          ok: true,
          message: `Bridged ${bridgeAmount} USDC to Arc!`,
          explorerUrl: done?.destinationExplorerUrl,
        });
        onRetryBalance();
      } catch (e) {
        fail(e);
      }
    },
    [authPost, toChain, walletAddress, executeChallenge, continueBridge, pollMintStatus, onRetryBalance, fail]
  );

  // ── Re-auth at bridge time ──────────────────────────────────────────────
  const handleLoginComplete = useCallback(
    (loginError: unknown, result: any) => {
      (async () => {
        if (cancelledRef.current) return;
        if (loginError || !result?.userToken) {
          fail(loginError ?? new Error('Sign-in failed.'));
          return;
        }
        // Publish the fresh login to the shared page-level session so every
        // consumer feature reuses it until Circle's API reports expiry.
        const freshToken = String(result.userToken);
        const freshCreds = {
          userToken: freshToken,
          encryptionKey: result.encryptionKey ? String(result.encryptionKey) : null,
          circleUserId: result.userId != null ? String(result.userId) : null,
        };
        setSession(freshCreds);
        try {
          sessionStorage.removeItem(PENDING_KEY);
        } catch {
          /* ignore */
        }
        // Resume a redirect-interrupted bridge, else run the current form.
        let pending: { fromChain?: string; amount?: string } | null = null;
        try {
          const raw = sessionStorage.getItem(PENDING_BRIDGE_KEY);
          pending = raw ? JSON.parse(raw) : null;
        } catch {
          pending = null;
        }
        if (pending?.fromChain && pending?.amount) {
          try {
            sessionStorage.removeItem(PENDING_BRIDGE_KEY);
          } catch {
            /* ignore */
          }
          onFromChainChange(pending.fromChain);
          setAmount(pending.amount);
          await runBridge(freshToken, pending.amount, pending.fromChain);
        } else if (amount && fromChain) {
          await runBridge(freshToken, amount, fromChain);
        } else {
          setPhase('idle');
          setBusy(false);
          setStatus(null);
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fail, runBridge, fromChain, onFromChainChange, setSession]
  );

  const startBridgeClick = useCallback(() => {
    if (!fromChain || !amount) {
      setError('Choose a source chain and amount first.');
      return;
    }
    setError(null);
    setResult(null);
    // Reuse the shared session when it is still valid — re-auth only when
    // the token is actually missing or expired, not on every navigation.
    const existingToken = getUserToken();
    if (existingToken) {
      void runBridge(existingToken, amount, fromChain);
    } else {
      setPhase('auth');
    }
  }, [fromChain, amount, runBridge, getUserToken]);

  const startGoogle = useCallback(async () => {
    setError(null);
    setBusy(true);
    setPhase('preparing');
    setStatus('Preparing secure sign-in…');
    try {
      // Persist the bridge intent across the OAuth redirect (form values
      // only — never credentials).
      try {
        sessionStorage.setItem(PENDING_BRIDGE_KEY, JSON.stringify({ fromChain, amount }));
      } catch {
        /* storage unavailable — redirect resume will fail closed below */
      }
      // Fresh SDK bound to this flow's login-complete handler (the SDK
      // captures the callback at construct time). Shared at the page level
      // so challenge execution survives view remounts.
      const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');
      const bound = new W3SSdk({ appSettings: { appId } }, handleLoginComplete);
      sharedSdkRef.current = bound;
      const deviceId: string = await bound.getDeviceId();
      const tokens = await circleProxy({ action: 'social-token', deviceId });
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({ deviceToken: tokens.deviceToken, deviceEncryptionKey: tokens.deviceEncryptionKey })
        );
      } catch {
        /* ignore */
      }
      bound.updateConfigs({
        appSettings: { appId },
        loginConfigs: {
          deviceToken: tokens.deviceToken,
          deviceEncryptionKey: tokens.deviceEncryptionKey,
          google: {
            clientId: googleClientId,
            redirectUri: `${window.location.origin}/consumer`,
            selectAccountPrompt: true,
          },
        },
      });
      setStatus('Redirecting to Google…');
      const { SocialLoginProvider } = await import('@circle-fin/w3s-pw-web-sdk/dist/src/types');
      await bound.performLogin(SocialLoginProvider.GOOGLE);
    } catch (e) {
      fail(e);
    }
  }, [appId, googleClientId, handleLoginComplete, fromChain, amount, fail]);

  const startEmail = useCallback(async () => {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      setError('Enter a valid email address first.');
      return;
    }
    setError(null);
    setBusy(true);
    setPhase('preparing');
    setStatus('Sending a verification code to your email…');
    try {
      const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');
      const bound = new W3SSdk({ appSettings: { appId } }, handleLoginComplete);
      sharedSdkRef.current = bound;
      const deviceId: string = await bound.getDeviceId();
      const tokens = await circleProxy({ action: 'email-token', deviceId, email: normalized });
      bound.updateConfigs({
        appSettings: { appId },
        loginConfigs: {
          deviceToken: tokens.deviceToken,
          deviceEncryptionKey: tokens.deviceEncryptionKey,
          otpToken: tokens.otpToken,
        },
      });
      setPhase('preparing');
      setStatus('Enter the code Circle emailed you…');
      bound.verifyOtp();
    } catch (e) {
      fail(e);
    }
  }, [email, appId, handleLoginComplete, fail]);

  // Rehydrate after the Google OAuth redirect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!appId || autoResumedRef.current) return;
      const hasOAuthResponse = /access_token=|id_token=|[?&]code=/.test(
        window.location.hash + window.location.search
      );
      if (!hasOAuthResponse) {
        try {
          sessionStorage.removeItem(PENDING_KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      let pending: { deviceToken?: string; deviceEncryptionKey?: string } | null = null;
      try {
        const raw = sessionStorage.getItem(PENDING_KEY);
        pending = raw ? JSON.parse(raw) : null;
      } catch {
        pending = null;
      }
      if (!pending?.deviceToken || !pending?.deviceEncryptionKey) return;
      if (cancelled) return;
      autoResumedRef.current = true;
      setPhase('preparing');
      setStatus('Completing Google sign-in…');
      setBusy(true);
      try {
        const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');
        const bound = new W3SSdk(
          {
            appSettings: { appId },
            loginConfigs: {
              deviceToken: pending.deviceToken,
              deviceEncryptionKey: pending.deviceEncryptionKey,
              google: {
                clientId: googleClientId,
                redirectUri: `${window.location.origin}/consumer`,
                selectAccountPrompt: true,
              },
            },
          },
          handleLoginComplete
        );
        sharedSdkRef.current = bound;
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // The shared session outlives this view: navigating to Swap/Save/etc.
  // unmounts the bridge but must NOT drop the login. Cleanup only cancels
  // in-flight work; expiry/disconnect clears the session itself.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  if (!appId) {
    // Circle user-controlled signing is not configured — stopgap copy.
    return (
      <p style={styles.text}>Bridging support for your wallet type is being added - check back soon</p>
    );
  }

  const inFlight = busy && phase !== 'idle' && phase !== 'auth';

  return (
    <div style={styles.form}>
      {!result && phase !== 'auth' && (
        <>
          <div style={styles.field}>
            <label style={styles.label}>Source Chain</label>
            <div style={styles.selectWrap}>
              <select
                value={fromChain}
                onChange={(e) => {
                  setAmount('');
                  onFromChainChange(e.target.value);
                }}
                style={styles.select}
                aria-label="Select the chain to bridge from"
              >
                {chains.length === 0 && <option value="">Loading chains…</option>}
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} {c.testnet ? '(testnet)' : ''}
                  </option>
                ))}
              </select>
              <span style={styles.selectChevron} aria-hidden="true">▾</span>
            </div>
            <div style={styles.chainBalanceRow}>
              {chainBalanceLoading ? (
                <span style={styles.chainBalanceText}>Checking balance…</span>
              ) : chainBalanceError ? (
                <>
                  <span style={styles.chainBalanceErrorText}>{chainBalanceError}</span>
                  <button style={styles.chainBalanceRetry} onClick={onRetryBalance}>Retry</button>
                </>
              ) : (
                <>
                  <span style={styles.chainBalanceText}>
                    Available: <strong>{chainBalance !== null ? `${parseFloat(chainBalance).toFixed(2)} USDC` : '—'}</strong>
                  </span>
                  <button
                    style={styles.maxButton}
                    disabled={!chainBalance || parseFloat(chainBalance) <= 0}
                    onClick={() => setAmount(String(parseFloat(chainBalance!)))}
                  >
                    Max
                  </button>
                </>
              )}
            </div>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Amount (USDC)</label>
            <input
              style={styles.input}
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Arriving in</label>
            <div style={{ ...styles.input, background: 'var(--flow-surface-2)', display: 'flex', alignItems: 'center', fontFamily: 'monospace', fontSize: 'clamp(11px, 1vw, 13px)' }}>
              Your wallet ({walletAddress.slice(0, 6)}...{walletAddress.slice(-4)})
            </div>
          </div>
          <p style={styles.hint}>
            Your wallet is secured by Circle — each step asks for your approval in a Circle prompt. FlareHQ never sees your keys.
          </p>
          <button
            style={styles.submitButton}
            disabled={
              busy ||
              !amount ||
              !fromChain ||
              chains.length === 0 ||
              (chainBalance !== null && parseFloat(amount || '0') > parseFloat(chainBalance))
            }
            onClick={startBridgeClick}
          >
            {busy
              ? 'Working…'
              : chains.length === 0
                ? 'Loading chains...'
                : chainBalance !== null && parseFloat(amount || '0') > parseFloat(chainBalance)
                  ? 'Amount exceeds available balance'
                  : 'Bridge to Arc'}
          </button>
        </>
      )}

      {inFlight && (
        <>
          <p style={styles.text}>{status ?? 'Working…'}</p>
          <p style={styles.hint}>Do not close this page — your bridge is in progress.</p>
        </>
      )}

      {phase === 'auth' && !busy && (
        <>
          <p style={styles.text}>Sign in with the same method you used to create this wallet — bridging needs your approval.</p>
          <div style={styles.tabs}>
            <button
              style={mode === 'google' ? styles.tabActive : styles.tab}
              onClick={() => { setMode('google'); setError(null); }}
            >
              Google
            </button>
            <button
              style={mode === 'email' ? styles.tabActive : styles.tab}
              onClick={() => { setMode('email'); setError(null); }}
            >
              Email
            </button>
          </div>
          {mode === 'google' ? (
            <button style={styles.submitButton} disabled={busy || !googleClientId} onClick={startGoogle}>
              Continue with Google
            </button>
          ) : (
            <>
              <input
                style={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                inputMode="email"
                autoComplete="email"
              />
              <button style={styles.submitButton} disabled={busy} onClick={startEmail}>
                Continue with email
              </button>
            </>
          )}
          <button style={styles.ghostButton} onClick={() => { setPhase('idle'); setBusy(false); setError(null); }}>
            Back
          </button>
        </>
      )}

      {error && <p style={styles.error}>{error}</p>}

      {result && (
        <div style={result.ok ? styles.resultSuccess : styles.resultError}>
          <p style={styles.resultIcon}>{result.ok ? '✓' : '!'}</p>
          <p style={styles.resultText}>{result.message}</p>
          {result.explorerUrl && (
            <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
              View transaction
            </a>
          )}
          <button
            style={styles.doneButton}
            onClick={() => { setResult(null); setAmount(''); setPhase('idle'); onRetryBalance(); }}
          >
            Bridge again
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--flow-text-faint)' },
  input: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 10,
    border: '1px solid var(--flow-border, var(--border))',
    background: 'transparent',
    color: 'var(--flow-text, var(--text))',
    fontSize: 14,
    boxSizing: 'border-box',
  },
  selectWrap: { position: 'relative' },
  select: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 10,
    border: '1px solid var(--flow-border, var(--border))',
    background: 'transparent',
    color: 'var(--flow-text, var(--text))',
    fontSize: 14,
    appearance: 'none',
    boxSizing: 'border-box',
  },
  selectChevron: { position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' },
  chainBalanceRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  chainBalanceText: { fontSize: 12, color: 'var(--flow-text-faint)' },
  chainBalanceErrorText: { fontSize: 12, color: '#C0563A' },
  chainBalanceRetry: { background: 'none', border: 'none', color: 'var(--flow-text, var(--text))', fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' },
  maxButton: {
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid var(--flow-border, var(--border))',
    background: 'transparent',
    color: 'var(--flow-text, var(--text))',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  text: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' },
  hint: { margin: 0, fontSize: 12, color: 'var(--text-secondary)' },
  error: { margin: 0, fontSize: 13, color: '#C0563A' },
  submitButton: {
    width: '100%',
    padding: '12px 16px',
    borderRadius: 12,
    border: 'none',
    background: 'var(--flow-text, var(--text))',
    color: 'var(--flow-surface, var(--surface))',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
  },
  tabs: { display: 'flex', gap: 8 },
  tab: {
    flex: 1,
    padding: '9px 0',
    borderRadius: 10,
    border: '1px solid var(--flow-border, var(--border))',
    background: 'transparent',
    color: 'var(--flow-text, var(--text))',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  tabActive: {
    flex: 1,
    padding: '9px 0',
    borderRadius: 10,
    border: '1px solid var(--flow-text, var(--text))',
    background: 'var(--flow-text, var(--text))',
    color: 'var(--flow-surface, var(--surface))',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  ghostButton: { background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: 0 },
  resultSuccess: { border: '1px solid #2E7D4F', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
  resultError: { border: '1px solid #C0563A', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
  resultIcon: { margin: 0, fontSize: 18, fontWeight: 800 },
  resultText: { margin: 0, fontSize: 13 },
  resultLink: { fontSize: 13, fontWeight: 700 },
  doneButton: {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid var(--flow-border, var(--border))',
    background: 'transparent',
    color: 'var(--flow-text, var(--text))',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
};
