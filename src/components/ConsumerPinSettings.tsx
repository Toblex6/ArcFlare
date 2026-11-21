'use client';

import { useEffect, useRef, useState } from 'react';
import { useSecurePinDialog } from '@/components/SecurePinDialog';

// Secrets live only in masked dialogs and short-lived local variables.
export default function ConsumerPinSettings({ hasRecoveryEmail, maskedEmail, onChanged }: {
  hasRecoveryEmail: boolean; maskedEmail: string | null; onChanged: () => Promise<void>;
}) {
  const { requestPin, dialog } = useSecurePinDialog();
  const active = useRef(true), running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function submitPinChange(reset: boolean) {
    if (running.current) return;
    running.current = true; setBusy(true); setMessage(null);
    let currentPin = '', newPin = '', confirmPin = '', verificationCode = code;
    setCode('');
    try {
      if (reset && !/^\d{6}$/.test(verificationCode)) { setMessage('Enter the 6-digit email code.'); return; }
      if (!reset) {
        currentPin = await requestPin({ title: 'Change PIN', description: 'Enter your current payment PIN.', confirmLabel: 'Continue' }) ?? '';
        if (!currentPin || !active.current) return;
      }
      newPin = await requestPin({ title: 'Choose a new PIN', description: 'Choose a new 4–6 digit payment PIN.', confirmLabel: 'Continue' }) ?? '';
      if (!newPin || !active.current) return;
      confirmPin = await requestPin({ title: 'Confirm new PIN', description: 'Enter the new PIN again.', confirmLabel: reset ? 'Verify code & reset PIN' : 'Change PIN' }) ?? '';
      if (!confirmPin || !active.current) return;
      if (newPin !== confirmPin) { setMessage('New PINs do not match. Please start again.'); return; }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (!reset) headers['x-consumer-pin'] = currentPin;
      const response = await fetch(reset ? '/api/consumer/pin/reset' : '/api/consumer/pin', {
        method: 'PUT', headers, body: JSON.stringify({ newPin, confirmPin, ...(reset ? { code: verificationCode } : {}) }),
      });
      const result = await response.json();
      if (!active.current) return;
      if (!response.ok || !result.success) { setMessage(result.error || 'Could not change your PIN.'); return; }
      setResetOpen(false);
      setMessage(reset ? 'Payment PIN reset. Any existing security lockout still applies.' : 'Payment PIN changed.');
      await onChanged();
    } catch {
      if (active.current) setMessage('Could not change your PIN. Please try again.');
    } finally {
      currentPin = ''; newPin = ''; confirmPin = ''; verificationCode = '';
      running.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function requestReset() {
    if (running.current || cooldown > 0) return;
    running.current = true; setBusy(true); setMessage(null); setCode('');
    try {
      const response = await fetch('/api/consumer/pin/reset', { method: 'POST' });
      const result = await response.json();
      if (!active.current) return;
      if (!response.ok || !result.success) { setMessage(result.error || 'Could not send a code.'); return; }
      setResetOpen(true); setCooldown(30);
      setMessage('Check your recovery email. The code expires in 10 minutes and can be used once.');
    } catch {
      if (active.current) setMessage('Could not send a code. Please try again.');
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <div style={{ display: 'grid', gap: 8, paddingLeft: 24 }}>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button type="button" style={button} disabled={busy} onClick={() => submitPinChange(false)}>Change PIN</button>
      <button type="button" style={button} disabled={busy || !hasRecoveryEmail || cooldown > 0} onClick={requestReset}>
        {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Forgot PIN'}
      </button>
    </div>
    {!hasRecoveryEmail && <p style={note}>Add and verify a recovery email before using Forgot PIN.</p>}
    {resetOpen && <div style={{ display: 'grid', gap: 8 }}>
      <label style={note} htmlFor="pin-reset-code">Verification code sent to {maskedEmail ?? 'your verified recovery email'}</label>
      <input id="pin-reset-code" type="password" inputMode="numeric" autoComplete="off" maxLength={6}
        value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        style={{ padding: 12, borderRadius: 10, border: '1px solid var(--flow-border)', background: 'var(--flow-bg)', color: 'var(--flow-text)' }} />
      <p style={note}>Enter the code, then choose your new PIN. The server verifies the code before making any change. An existing lockout is not removed.</p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" style={button} disabled={busy || code.length !== 6} onClick={() => submitPinChange(true)}>Continue to new PIN</button>
        <button type="button" style={button} disabled={busy} onClick={() => { setResetOpen(false); setCode(''); setMessage(null); }}>Cancel</button>
      </div>
    </div>}
    {message && <p role="status" style={note}>{message}</p>}
    {dialog}
  </div>;
}

const button: React.CSSProperties = { background: 'transparent', border: 'none', padding: '4px 0', font: 'inherit', fontSize: 12, fontWeight: 700, color: 'var(--flow-text)', textDecoration: 'underline', cursor: 'pointer' };
const note: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--flow-text-muted)' };
