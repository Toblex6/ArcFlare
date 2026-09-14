// src/components/consumer/CircleUserWallet.tsx
//
// 'use client' — browser-only Circle user-controlled wallet onboarding for
// individual consumers (Google social login + email OTP).
//
// Flow (Circle's user-controlled model — the server never sees keys):
//   1. SDK deviceId → POST /api/consumer/circle {action:"social-token"|"email-token"}
//   2. Google: SDK performLogin (OAuth redirect) / Email: SDK verifyOtp modal
//      → Circle returns { userToken, encryptionKey, … } to the SDK callback
//   3. POST /api/consumer/circle {action:"initialize", userToken} → challengeId
//      (CIRCLE_155106 = returning user, wallet already exists → skip to 5)
//   4. SDK execute(challengeId) — the user approves wallet creation in Circle's UI
//   5. POST /api/consumer/circle {action:"wallets", userToken} → pick the Arc wallet
//   6. POST /api/consumer/session {circleAuth} → EXISTING consumer_token
//      session cookie (server verifies the address against Circle first)
//
// Secrets discipline: userToken/encryptionKey live in React state only —
// never localStorage, never cookies, cleared on unmount and after linking.
// Only the OAuth-redirect bridge (deviceToken/deviceEncryptionKey, which are
// short-lived device-bound tokens, NOT user credentials) touches
// sessionStorage so the SDK can rehydrate after Google redirects back.

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Configs } from '@circle-fin/w3s-pw-web-sdk/dist/src/types';

type Mode = 'google' | 'email';
type Phase =
  | 'choose'
  | 'preparing'
  | 'authenticating'
  | 'initializing'
  | 'executing'
  | 'linking'
  | 'done';

interface LinkedAccount {
  walletAddress: string;
  walletType: string | null;
  isNew: boolean;
}

const PENDING_KEY = 'flarehq-circle-pending-login';

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

function friendlyCircleError(e: any): string {
  const code = String(e?.code ?? '');
  if (code === 'CIRCLE_155106') return 'Returning sign-in detected — loading your existing wallet.';
  if (e?.status === 503 || code === 'CIRCLE_NOT_CONFIGURED' || code === 'CIRCLE_APP_ID_MISSING') {
    return 'FlareHQ wallet sign-in is not configured yet. Connect an external wallet instead, or try again later.';
  }
  const msg = String(e?.message ?? '');
  if (/cancel|cancelled|dismiss|popup|user denied|user rejected|access_denied/i.test(msg)) {
    return 'Sign-in was cancelled. Nothing was created — try again when ready.';
  }
  if (/otp|code|expired|invalid/i.test(msg)) {
    return 'That code did not verify. Request a new code and try again — codes expire after a few minutes.';
  }
  if (/network|fetch|failed|unavailable|502|500/i.test(msg)) {
    return 'Circle is unreachable right now. Check your connection and try again.';
  }
  return msg || 'Sign-in failed. Try again.';
}

export function CircleUserWallet({
  initialMode,
  onLinked,
  onClose,
}: {
  initialMode: Mode;
  onLinked: (account: LinkedAccount) => void;
  onClose: () => void;
}) {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

  const [mode, setMode] = useState<Mode>(initialMode);
  const [phase, setPhase] = useState<Phase>('choose');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const sdkRef = useRef<any>(null);
  const stateRef = useRef<{ userToken: string | null; encryptionKey: string | null; circleUserId: string | null }>({
    userToken: null,
    encryptionKey: null,
    circleUserId: null,
  });

  const fail = useCallback((e: any) => {
    setError(friendlyCircleError(e));
    setStatus(null);
    setBusy(false);
    setPhase('choose');
  }, []);

  // Finish: list wallets → link into the FlareHQ consumer session.
  const finishLink = useCallback(
    async (userToken: string, circleUserId: string | null) => {
      setPhase('linking');
      setStatus('Linking your wallet to FlareHQ…');
      const { wallets } = await circleProxy({ action: 'wallets', userToken });
      const list = Array.isArray(wallets) ? wallets : [];
      if (list.length === 0) {
        throw new Error('No Circle wallet found for this identity yet — finish creating the wallet first.');
      }
      const arc = list.find((w: any) => String(w?.blockchain ?? '').toUpperCase().includes('ARC')) ?? list[0];
      const res = await fetch('/api/consumer/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circleAuth: {
            userToken,
            walletAddress: arc.address,
            circleUserId,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        const err = new Error(data?.error || 'Could not link the wallet.') as any;
        err.code = data?.code;
        throw err;
      }
      // Drop Circle credentials from memory the moment the FlareHQ session exists.
      stateRef.current = { userToken: null, encryptionKey: null, circleUserId: null };
      try {
        sessionStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      setPhase('done');
      setBusy(false);
      onLinked({
        walletAddress: data.account.walletAddress,
        walletType: data.account.walletType ?? 'USER_CONTROLLED',
        isNew: data.isNew === true,
      });
    },
    [onLinked]
  );

  // Initialize-or-returning: challenge → execute → link, or straight to link.
  const initializeAndLink = useCallback(
    async (userToken: string, circleUserId: string | null) => {
      setPhase('initializing');
      setStatus('Setting up your wallet…');
      let challengeId: string | null = null;
      try {
        const init = await circleProxy({ action: 'initialize', userToken });
        challengeId = init?.challengeId ?? null;
      } catch (e: any) {
        if (String(e?.code ?? '') === 'CIRCLE_155106') {
          // Returning user — the wallet already exists. No challenge to run.
          setStatus('Welcome back — loading your existing wallet…');
          await finishLink(userToken, circleUserId);
          return;
        }
        throw e;
      }
      if (!challengeId) {
        // Defensive: no challenge and no error — re-list rather than invent one.
        await finishLink(userToken, circleUserId);
        return;
      }
      setPhase('executing');
      setStatus('Approve wallet creation in the Circle prompt…');
      const sdk = sdkRef.current;
      if (!sdk) throw new Error('Wallet SDK is not ready. Try again.');
      const { userToken: ut, encryptionKey } = stateRef.current;
      sdk.setAuthentication({ userToken: ut, encryptionKey });
      await new Promise<void>((resolve, reject) => {
        try {
          sdk.execute(challengeId as string, (err: any) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err?.message ?? err ?? 'Challenge failed.')));
            else resolve();
          });
        } catch (e) {
          reject(e);
        }
      });
      // Small delay so Circle can index the new wallet before we list it.
      await new Promise((r) => setTimeout(r, 2000));
      await finishLink(userToken, circleUserId);
    },
    [finishLink]
  );

  // Shared login-complete handler for Google (redirect) and email (OTP modal).
  const handleLoginComplete = useCallback(
    (loginError: unknown, result: any) => {
      (async () => {
        if (loginError || !result?.userToken) {
          const err = loginError as any;
          fail(err ?? new Error('Sign-in failed.'));
          return;
        }
        stateRef.current = {
          userToken: String(result.userToken),
          encryptionKey: result.encryptionKey ? String(result.encryptionKey) : null,
          circleUserId: result.userId != null ? String(result.userId) : null,
        };
        try {
          await initializeAndLink(stateRef.current.userToken as string, stateRef.current.circleUserId);
        } catch (e) {
          fail(e);
        }
      })();
    },
    [fail, initializeAndLink]
  );

  // Lazily construct the SDK (browser-only import — never bundled server-side).
  const ensureSdk = useCallback(
    async (loginConfigs?: Configs['loginConfigs']) => {
    if (sdkRef.current) {
      if (loginConfigs) sdkRef.current.updateConfigs({ appSettings: { appId }, loginConfigs });
      return sdkRef.current;
    }
      const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');
      const sdk = new W3SSdk(
        {
          appSettings: { appId },
          ...(loginConfigs ? { loginConfigs } : {}),
        },
        handleLoginComplete
      );
      sdkRef.current = sdk;
      return sdk;
    },
    [appId, handleLoginComplete]
  );

  // Rehydrate after the Google OAuth redirect: the freshly constructed SDK
  // picks up the redirect result and fires handleLoginComplete.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!appId) return;
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
      setPhase('authenticating');
      setStatus('Completing Google sign-in…');
      setBusy(true);
      try {
        await ensureSdk({
          deviceToken: pending.deviceToken,
          deviceEncryptionKey: pending.deviceEncryptionKey,
          google: {
            clientId: googleClientId,
            redirectUri: `${window.location.origin}/consumer`,
            selectAccountPrompt: true,
          },
        });
        // The SDK fires handleLoginComplete on redirect success/failure.
        // If it never fires (user abandoned Google), the Cancel button below
        // clears the pending state.
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // Drop in-memory Circle credentials on unmount — they must not outlive this flow.
  useEffect(() => {
    return () => {
      stateRef.current = { userToken: null, encryptionKey: null, circleUserId: null };
    };
  }, []);

  const startGoogle = useCallback(async () => {
    setError(null);
    setBusy(true);
    setPhase('preparing');
    setStatus('Preparing secure sign-in…');
    try {
      const sdk = await ensureSdk();
      const deviceId: string = await sdk.getDeviceId();
      const tokens = await circleProxy({ action: 'social-token', deviceId });
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({
            deviceToken: tokens.deviceToken,
            deviceEncryptionKey: tokens.deviceEncryptionKey,
          })
        );
      } catch {
        /* storage unavailable — redirect rehydration will fail closed below */
      }
      sdk.updateConfigs({
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
      setPhase('authenticating');
      setStatus('Redirecting to Google…');
      const { SocialLoginProvider } = await import('@circle-fin/w3s-pw-web-sdk/dist/src/types');
      await sdk.performLogin(SocialLoginProvider.GOOGLE);
      // Control leaves to Google here; completion resumes via the redirect
      // rehydration effect above.
    } catch (e) {
      fail(e);
    }
  }, [appId, googleClientId, ensureSdk, fail]);

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
      const sdk = await ensureSdk();
      const deviceId: string = await sdk.getDeviceId();
      const tokens = await circleProxy({ action: 'email-token', deviceId, email: normalized });
      sdk.updateConfigs({
        appSettings: { appId },
        loginConfigs: {
          deviceToken: tokens.deviceToken,
          deviceEncryptionKey: tokens.deviceEncryptionKey,
          otpToken: tokens.otpToken,
        },
      });
      setPhase('authenticating');
      setStatus('Enter the code Circle emailed you…');
      sdk.verifyOtp();
      // Completion (or failure/cancel) resumes via handleLoginComplete.
    } catch (e) {
      fail(e);
    }
  }, [email, appId, ensureSdk, fail]);

  const cancelPending = useCallback(() => {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    stateRef.current = { userToken: null, encryptionKey: null, circleUserId: null };
    setBusy(false);
    setPhase('choose');
    setStatus(null);
    setError(null);
  }, []);

  if (!appId) {
    return (
      <div style={styles.panel}>
        <p style={styles.title}>FlareHQ wallet</p>
        <p style={styles.text}>
          FlareHQ wallet sign-in is not configured yet. Connect an external wallet instead, or try again later.
        </p>
        <button style={styles.secondaryButton} onClick={onClose}>
          Back
        </button>
      </div>
    );
  }

  const inFlight = busy && phase !== 'choose';

  return (
    <div style={styles.panel} aria-label="FlareHQ wallet sign-in">
      <p style={styles.title}>FlareHQ wallet</p>
      <p style={styles.text}>
        Your wallet is owned by you and secured by Circle — FlareHQ never sees your keys. Sign in the same way
        next time to get back to this exact wallet.
      </p>

      {phase === 'choose' && (
        <>
          <div style={styles.tabs}>
            <button
              style={mode === 'google' ? styles.tabActive : styles.tab}
              onClick={() => {
                setMode('google');
                setError(null);
              }}
            >
              Google
            </button>
            <button
              style={mode === 'email' ? styles.tabActive : styles.tab}
              onClick={() => {
                setMode('email');
                setError(null);
              }}
            >
              Email
            </button>
          </div>

          {mode === 'google' ? (
            <>
              <button style={styles.primaryButton} disabled={busy || !googleClientId} onClick={startGoogle}>
                Continue with Google
              </button>
              {!googleClientId && (
                <p style={styles.hint}>Google sign-in is not configured yet — use email or connect a wallet.</p>
              )}
            </>
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
              <button style={styles.primaryButton} disabled={busy} onClick={startEmail}>
                Continue with email
              </button>
              <p style={styles.hint}>Circle emails you a one-time code — no password to remember.</p>
            </>
          )}

          <button style={styles.ghostButton} onClick={onClose}>
            Back
          </button>
        </>
      )}

      {inFlight && (
        <>
          <p style={styles.text}>{status ?? 'Working…'}</p>
          {(phase === 'authenticating' || phase === 'preparing') && (
            <button style={styles.secondaryButton} onClick={cancelPending}>
              Cancel
            </button>
          )}
          {phase !== 'authenticating' && phase !== 'preparing' && (
            <p style={styles.hint}>Do not close this page — your wallet is being set up.</p>
          )}
        </>
      )}

      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '100%',
    maxWidth: 340,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginTop: 12,
    border: '1px solid var(--flow-border, var(--border))',
    borderRadius: 14,
    padding: 16,
    background: 'var(--flow-surface, var(--surface))',
    boxSizing: 'border-box',
  },
  title: { margin: 0, fontSize: 14, fontWeight: 800 },
  text: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' },
  hint: { margin: 0, fontSize: 12, color: 'var(--text-secondary)' },
  error: { margin: 0, fontSize: 13, color: '#C0563A' },
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
  primaryButton: {
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
  secondaryButton: {
    width: '100%',
    padding: '11px 14px',
    borderRadius: 10,
    border: '1px solid var(--flow-border, var(--border))',
    background: 'transparent',
    color: 'var(--flow-text, var(--text))',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  ghostButton: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
  },
};
