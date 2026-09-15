// src/components/consumer/UserControlledSave.tsx
//
// 'use client' — savings-reminder UX for Circle USER_CONTROLLED wallets.
//
// These wallets cannot be debited server-side (only the owner signs through
// Circle), so the automatic scheduled-debit path is honestly unavailable.
// Instead the user sets up a savings PLAN (amount + frequency, same fields
// as the automatic form) and each cycle produces a pending "Ready to save"
// prompt they open and approve with ONE Circle challenge
// (setAuthentication -> execute, same pattern as UserControlledBridge).
//
// This is a scheduled reminder + one-tap approval — NOT automation. Copy
// below must never claim otherwise: "We'll remind you when it's time — you
// approve each transfer." Words like "automatic" / "runs itself" must not
// appear in this file.
//
// Plans live in the browser (localStorage per wallet); the server only
// mints and verifies the per-cycle transfer challenge
// (POST /api/consumer/save/challenge → execute → POST
// /api/consumer/save/confirm). Nothing here touches the CIRCLE automatic
// path or merchant payroll code.

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCircleSession } from './CircleSessionContext';

export interface UcSavePlan {
  id: string;
  amount: string;
  frequencyDays: number;
  destination: string;
  nextDueAt: number;
  createdAt: number;
  completedCount: number;
}

function plansKey(walletAddress: string): string {
  return `flarehq-uc-save-plans:${walletAddress.toLowerCase()}`;
}

function loadPlans(walletAddress: string): UcSavePlan[] {
  try {
    const raw = localStorage.getItem(plansKey(walletAddress));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        typeof p.amount === 'string' &&
        Number.isFinite(Number(p.frequencyDays)) &&
        Number(p.frequencyDays) > 0 &&
        typeof p.nextDueAt === 'number'
    );
  } catch {
    return [];
  }
}

function storePlans(walletAddress: string, plans: UcSavePlan[]): void {
  try {
    localStorage.setItem(plansKey(walletAddress), JSON.stringify(plans));
  } catch {
    /* storage unavailable — plans stay in memory for this visit */
  }
}

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
    return 'Your Circle sign-in expired — sign in again and retry this savings step.';
  }
  if (code === 'USE_AUTOMATIC_SAVE') {
    return 'This wallet saves on a schedule by itself — use the automatic Save form instead.';
  }
  if (code === 'CHALLENGE_PENDING') {
    return 'Waiting for your approval in the Circle prompt…';
  }
  if (code === 'TX_CONFIRMING') {
    return 'Confirming on-chain — continue again in a moment…';
  }
  if (code === 'UNKNOWN_REFERENCE' || code === 'CHALLENGE_MISMATCH') {
    return 'This savings step expired — start the step again.';
  }
  const msg = String(e?.message ?? '');
  if (/cancel|cancelled|dismiss|popup|user denied|user rejected|access_denied/i.test(msg)) {
    return 'Approval was cancelled in the Circle prompt — nothing moved. Try again when ready.';
  }
  return msg || 'Savings step failed. Try again.';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PENDING_KEY = 'flarehq-circle-pending-login';

export function UserControlledSave({
  walletAddress,
  authPost,
}: {
  walletAddress: string;
  // PIN-aware POST helper for the two save routes
  // ('challenge' → /api/consumer/save/challenge, 'confirm' →
  // /api/consumer/save/confirm): (route, body) => parsed JSON, throws on
  // failure. The page wires this to its protectedFetch (step-up headers).
  authPost: (route: 'challenge' | 'confirm', body: Record<string, unknown>) => Promise<any>;
}) {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

  const [plans, setPlans] = useState<UcSavePlan[]>([]);
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState('7');
  const [formError, setFormError] = useState<string | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'auth' | 'working'>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ planId: string; message: string; explorerUrl?: string } | null>(null);
  const [mode, setMode] = useState<'google' | 'email'>('google');
  const [email, setEmail] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const { getUserToken, getEncryptionKey, setSession, clearSession, sdkRef: sharedSdkRef } =
    useCircleSession();
  const cancelledRef = useRef(false);
  const pendingPlanRef = useRef<UcSavePlan | null>(null);

  useEffect(() => {
    setPlans(loadPlans(walletAddress));
    setActivePlanId(null);
    setPhase('idle');
    setStatus(null);
    setError(null);
    setDone(null);
  }, [walletAddress]);

  // Re-render due badges as time passes (cheap 30s tick).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const persist = useCallback(
    (next: UcSavePlan[]) => {
      setPlans(next);
      storePlans(walletAddress, next);
    },
    [walletAddress]
  );

  const duePlans = useMemo(() => plans.filter((p) => p.nextDueAt <= now), [plans, now]);
  const upcomingPlans = useMemo(() => plans.filter((p) => p.nextDueAt > now), [plans, now]);

  const createPlan = useCallback(() => {
    setFormError(null);
    const amt = amount.trim();
    if (!/^\d+(\.\d{1,6})?$/.test(amt) || Number(amt) <= 0) {
      setFormError('Enter a positive USDC amount (up to 6 decimals).');
      return;
    }
    const days = parseInt(frequency, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      setFormError('Choose a frequency between 1 and 3650 days.');
      return;
    }
    const plan: UcSavePlan = {
      id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      amount: amt,
      frequencyDays: days,
      destination: walletAddress,
      nextDueAt: Date.now(),
      createdAt: Date.now(),
      completedCount: 0,
    };
    persist([plan, ...plans]);
    setAmount('');
    setFrequency('7');
  }, [amount, frequency, plans, persist, walletAddress]);

  const deletePlan = useCallback(
    (id: string) => {
      persist(plans.filter((p) => p.id !== id));
      if (activePlanId === id) {
        setActivePlanId(null);
        setPhase('idle');
        setStatus(null);
        setError(null);
      }
    },
    [plans, persist, activePlanId]
  );

  const ensureExecutionSdk = useCallback(async () => {
    if (sharedSdkRef.current) return sharedSdkRef.current;
    const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk');
    const sdk = new W3SSdk({ appSettings: { appId } }, () => {});
    sharedSdkRef.current = sdk;
    return sdk;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

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

  const runSaveCycle = useCallback(
    async (userToken: string, plan: UcSavePlan) => {
      setPhase('working');
      setError(null);
      setDone(null);
      setStatus('Preparing your savings transfer…');
      try {
        const init = await authPost('challenge', {
          amount: plan.amount,
          destination: plan.destination,
          userToken,
        });
        const reference = String(init?.reference ?? '');
        const challengeId = String(init?.challengeId ?? '');
        if (!reference || !challengeId) throw new Error('Savings initiation returned an incomplete step.');
        setStatus('Approve this savings transfer in the Circle prompt…');
        await executeChallenge(challengeId);
        setStatus('Verifying your approval on-chain…');
        // Retryable confirm poll: confirming states resolve on retry.
        let lastErr: any = null;
        for (let i = 0; i < 20; i++) {
          if (cancelledRef.current) throw new Error('Savings step cancelled.');
          try {
            const confirmed = await authPost('confirm', { reference, challengeId, userToken });
            if (cancelledRef.current) return;
            const nextDueAt = Date.now() + plan.frequencyDays * 24 * 60 * 60 * 1000;
            persist(
              plans.map((p) =>
                p.id === plan.id ? { ...p, nextDueAt, completedCount: p.completedCount + 1 } : p
              )
            );
            setPhase('idle');
            setStatus(null);
            setActivePlanId(null);
            setDone({
              planId: plan.id,
              message: `Saved ${plan.amount} USDC — we'll remind you again in ${plan.frequencyDays} day(s), and you approve each transfer.`,
              explorerUrl: confirmed?.explorerUrl,
            });
            return;
          } catch (e: any) {
            const code = String(e?.code ?? '');
            if (code === 'CHALLENGE_PENDING' || code === 'TX_CONFIRMING') {
              lastErr = e;
              setStatus(friendlyError(e));
              await sleep(5000);
              continue;
            }
            throw e;
          }
        }
        throw lastErr ?? new Error('The savings step is taking longer than expected — continue again shortly.');
      } catch (e: any) {
        if (cancelledRef.current) return;
        if (String(e?.code ?? '') === 'USER_TOKEN_REQUIRED') clearSession();
        setError(friendlyError(e));
        setStatus(null);
        setPhase('idle');
      }
    },
    [authPost, executeChallenge, plans, persist, clearSession]
  );

  const handleLoginComplete = useCallback(
    (loginError: unknown, result: any) => {
      (async () => {
        if (cancelledRef.current) return;
        if (loginError || !result?.userToken) {
          setError('Sign-in failed — try again.');
          setPhase('idle');
          setStatus(null);
          return;
        }
        const freshToken = String(result.userToken);
        setSession({
          userToken: freshToken,
          encryptionKey: result.encryptionKey ? String(result.encryptionKey) : null,
          circleUserId: result.userId != null ? String(result.userId) : null,
        });
        try {
          sessionStorage.removeItem(PENDING_KEY);
        } catch {
          /* ignore */
        }
        const plan = pendingPlanRef.current;
        pendingPlanRef.current = null;
        if (plan) {
          await runSaveCycle(freshToken, plan);
        } else {
          setPhase('idle');
          setStatus(null);
        }
      })();
    },
    [runSaveCycle, setSession]
  );

  const startSaveClick = useCallback(
    (plan: UcSavePlan) => {
      setError(null);
      setDone(null);
      setActivePlanId(plan.id);
      const existingToken = getUserToken();
      if (existingToken) {
        void runSaveCycle(existingToken, plan);
      } else {
        pendingPlanRef.current = plan;
        setPhase('auth');
      }
    },
    [getUserToken, runSaveCycle]
  );

  const startGoogle = useCallback(async () => {
    setError(null);
    setPhase('working');
    setStatus('Preparing secure sign-in…');
    try {
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
      setError(friendlyError(e));
      setPhase('idle');
      setStatus(null);
    }
  }, [appId, googleClientId, handleLoginComplete, sharedSdkRef]);

  const startEmail = useCallback(async () => {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      setError('Enter a valid email address first.');
      return;
    }
    setError(null);
    setPhase('working');
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
      setStatus('Enter the code Circle emailed you…');
      bound.verifyOtp();
    } catch (e) {
      setError(friendlyError(e));
      setPhase('idle');
      setStatus(null);
    }
  }, [email, appId, handleLoginComplete, sharedSdkRef]);

  if (!appId) {
    return (
      <p style={styles.text}>Savings reminders for your wallet type are being added — check back soon.</p>
    );
  }

  return (
    <div style={styles.wrap}>
      <p style={styles.honest}>
        Your wallet needs your approval for every transfer, so savings here work as reminders — not
        debits from your wallet. Set a plan below: we&apos;ll remind you when it&apos;s time — you
        approve each transfer in one Circle prompt.
      </p>

      <div style={styles.field}>
        <label style={styles.label}>Amount (USDC)</label>
        <input
          style={styles.input}
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          aria-label="Savings amount in USDC"
        />
      </div>
      <div style={styles.field}>
        <label style={styles.label}>How often should we remind you? (days)</label>
        <div style={styles.freqRow}>
          {[{ label: 'Daily', val: '1' }, { label: 'Weekly', val: '7' }, { label: 'Monthly', val: '30' }].map((f) => (
            <button
              key={f.val}
              style={frequency === f.val ? styles.freqPillActive : styles.freqPill}
              onClick={() => setFrequency(f.val)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          style={{ ...styles.input, marginTop: 6 }}
          type="number"
          min="1"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
          placeholder="Custom interval in days"
          aria-label="Reminder interval in days"
        />
      </div>
      {formError && <p style={styles.error}>{formError}</p>}
      <button style={styles.submitButton} onClick={createPlan} disabled={!amount.trim()} type="button">
        Create savings reminder
      </button>

      {duePlans.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={styles.sectionTitle}>Ready to save ({duePlans.length})</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {duePlans.map((plan) => (
              <div key={plan.id} style={styles.dueCard}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
                  Ready to save {plan.amount} USDC
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--flow-text-muted)' }}>
                  Reminder every {plan.frequencyDays} day(s) · {plan.completedCount} completed · nothing
                  moves until you approve it below.
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    style={styles.approveButton}
                    onClick={() => startSaveClick(plan)}
                    disabled={phase === 'working'}
                    type="button"
                  >
                    {phase === 'working' && activePlanId === plan.id ? 'Working…' : 'Review & approve'}
                  </button>
                  <button
                    style={styles.ghostButton}
                    onClick={() => deletePlan(plan.id)}
                    disabled={phase === 'working'}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {upcomingPlans.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={styles.sectionTitle}>Upcoming reminders</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {upcomingPlans.map((plan) => (
              <div key={plan.id} style={styles.planCard}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                    {plan.amount} USDC{' '}
                    <span style={{ fontWeight: 500, color: 'var(--flow-text-muted)' }}>
                      every {plan.frequencyDays} day(s)
                    </span>
                  </p>
                  <span style={styles.reminderBadge}>REMINDER</span>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--flow-text-faint)' }}>
                  Next reminder {new Date(plan.nextDueAt).toLocaleString()} · {plan.completedCount} approved
                  so far · you approve each transfer.
                </p>
                <button
                  style={{ ...styles.ghostButton, marginTop: 10 }}
                  onClick={() => deletePlan(plan.id)}
                  disabled={phase === 'working'}
                  type="button"
                >
                  Remove reminder
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {plans.length === 0 && (
        <p style={{ ...styles.text, marginTop: 14 }}>
          No savings reminders yet — create one above. The first reminder is due right away so you can
          try the one-tap approval.
        </p>
      )}

      {phase === 'working' && status && (
        <p style={{ ...styles.text, marginTop: 12 }}>{status}</p>
      )}

      {phase === 'auth' && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={styles.text}>
            Sign in with the same method you used to create this wallet — approving needs your Circle
            approval, and nothing moves without it.
          </p>
          <div style={styles.tabs}>
            <button
              style={mode === 'google' ? styles.tabActive : styles.tab}
              onClick={() => { setMode('google'); setError(null); }}
              type="button"
            >
              Google
            </button>
            <button
              style={mode === 'email' ? styles.tabActive : styles.tab}
              onClick={() => { setMode('email'); setError(null); }}
              type="button"
            >
              Email
            </button>
          </div>
          {mode === 'google' ? (
            <button style={styles.submitButton} disabled={!googleClientId} onClick={startGoogle} type="button">
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
              <button style={styles.submitButton} onClick={startEmail} type="button">
                Continue with email
              </button>
            </>
          )}
          <button
            style={styles.ghostButton}
            onClick={() => { setPhase('idle'); setActivePlanId(null); pendingPlanRef.current = null; setError(null); }}
            type="button"
          >
            Back
          </button>
        </div>
      )}

      {error && <p style={styles.error}>{error}</p>}

      {done && (
        <div style={styles.resultSuccess}>
          <p style={styles.resultIcon}>✓</p>
          <p style={styles.resultText}>{done.message}</p>
          {done.explorerUrl && (
            <a href={done.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
              View transaction
            </a>
          )}
          <button style={styles.doneButton} onClick={() => setDone(null)} type="button">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 12 },
  honest: { margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' },
  text: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' },
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
  freqRow: { display: 'flex', gap: 8 },
  freqPill: {
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
  freqPillActive: {
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
  approveButton: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: '#1C1B19',
    color: '#FBF8F3',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  ghostButton: {
    background: 'none',
    border: '1px solid var(--flow-border, var(--border))',
    borderRadius: 10,
    color: 'var(--flow-text, var(--text))',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    padding: '10px 14px',
  },
  sectionTitle: { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: 'var(--flow-text-muted)' },
  dueCard: {
    background: 'var(--flow-surface)',
    border: '1px solid var(--flow-text, var(--text))',
    borderRadius: 12,
    padding: '12px 14px',
  },
  planCard: { background: 'var(--flow-surface-2)', borderRadius: 12, padding: '12px 14px' },
  reminderBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: '#8a6d1b',
    background: 'rgba(138,109,27,0.12)',
    padding: '3px 8px',
    borderRadius: 8,
    whiteSpace: 'nowrap',
  },
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
  resultSuccess: { border: '1px solid #2E7D4F', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
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
