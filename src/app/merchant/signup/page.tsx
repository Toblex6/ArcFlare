//src\app\merchant\signup\page.tsx
'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

type Step = 'form' | 'verify' | 'done';

export default function MerchantSignup() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('form');
  const [form, setForm] = useState({ email: '', businessName: '', password: '', confirm: '' });
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      // Every merchant starts on a Circle-managed wallet — connecting your
      // own wallet (MetaMask, WalletConnect, Coinbase) happens after
      // signing in, from Settings, where ownership can actually be proven
      // by signing a message. There's no session to prove ownership
      // against yet at this point in the flow.
      const res = await fetch('/api/merchant/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          businessName: form.businessName,
          password: form.password,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStep('verify');
    } catch (err: any) {
      setError(err.message || 'Signup failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/merchant/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, code }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setApiKey(data.apiKey);
      setStep('done');
    } catch (err: any) {
      setError(err.message || 'Verification failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    setResendMsg(null);
    try {
      const res = await fetch('/api/merchant/resend-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setResendMsg('A new code has been sent.');
    } catch (err: any) {
      setError(err.message || 'Could not resend code.');
    }
  };

  const copyKey = () => {
    if (!apiKey) return;
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shellStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: 'var(--background)',
    color: 'var(--text)',
    fontFamily: 'Inter, system-ui, sans-serif',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  };
  const cardStyle: React.CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 24,
    padding: 36,
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    color: 'var(--text-secondary)',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--surface-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '12px 14px',
    color: 'var(--text)',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  };
  const primaryBtnStyle = (disabled: boolean): React.CSSProperties => ({
    marginTop: 8,
    padding: '14px',
    background: disabled ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
    color: disabled ? 'rgba(14,11,8,0.5)' : 'var(--background)',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 800,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s',
  });

  // ── API Key reveal screen ─────────────────────────────────────────────────
  if (step === 'done' && apiKey) {
    return (
      <main style={shellStyle}>
        <div style={{ width: '100%', maxWidth: 520 }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <Image src="/arcflare-logo.png" alt="FlareHQ" width={52} height={52} style={{ borderRadius: 14, objectFit: 'contain', marginBottom: 16 }} />
            <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', margin: '0 0 8px' }}>Account Verified</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Your API key is shown below. Save it now — it won't appear again.</p>
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--warning)', borderRadius: 20, padding: 28, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <p style={{ color: 'var(--warning)', fontSize: 12, fontWeight: 700, margin: 0, textTransform: 'uppercase', letterSpacing: 1 }}>
                Save this key — shown once only
              </p>
            </div>
            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', fontFamily: 'monospace', fontSize: 13, color: 'var(--primary)', wordBreak: 'break-all', marginBottom: 16 }}>
              {apiKey}
            </div>
            <button
              onClick={copyKey}
              style={{
                width: '100%', padding: '12px',
                background: copied ? 'rgba(13,124,95,0.2)' : 'rgba(200,151,90,0.15)',
                border: `1px solid ${copied ? 'rgba(13,124,95,0.4)' : 'rgba(200,151,90,0.3)'}`,
                borderRadius: 10, color: copied ? 'var(--success)' : 'var(--primary)',
                fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {copied ? '✓ Copied to clipboard' : 'Copy API Key'}
            </button>
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 20 }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: 1 }}>
              Quick Start
            </p>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--primary)', background: 'var(--background)', borderRadius: 8, padding: 14, lineHeight: 1.8 }}>
              <span style={{ color: 'var(--text-secondary)' }}># Create a payment link</span>
              <br />
              curl -X POST https://flarehq.xyz/api/payments/initialize \<br />
              &nbsp;&nbsp;-H <span style={{ color: 'var(--text)' }}>"x-api-key: {apiKey.slice(0, 20)}..."</span> \
              <br />
              &nbsp;&nbsp;-d <span style={{ color: 'var(--text)' }}>'&#123;"amount":"10","currency":"USDC","merchant":"Your Business"&#125;'</span>
            </div>
          </div>

          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 20px' }}>
            You've got a Circle-managed payout wallet — withdraw anytime from your dashboard, or connect your own wallet (MetaMask, WalletConnect, Coinbase) anytime from Settings.
          </p>

          <button onClick={() => router.push('/merchant/login')} style={primaryBtnStyle(false)}>
            Continue to Login →
          </button>
        </div>
      </main>
    );
  }

  // ── Verification code screen ──────────────────────────────────────────────
  if (step === 'verify') {
    return (
      <main style={shellStyle}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <Image src="/arcflare-logo.png" alt="FlareHQ" width={52} height={52} style={{ borderRadius: 14, objectFit: 'contain', marginBottom: 16 }} />
            <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', margin: '0 0 8px' }}>Check your email</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>We sent a 6-digit code to {form.email}</p>
          </div>

          <div style={cardStyle}>
            {error && (
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
                <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>❌ {error}</p>
              </div>
            )}
            {resendMsg && (
              <div style={{ background: 'rgba(13,124,95,0.08)', border: '1px solid rgba(13,124,95,0.2)', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
                <p style={{ color: 'var(--success)', fontSize: 13, margin: 0 }}>✓ {resendMsg}</p>
              </div>
            )}

            <form onSubmit={handleVerify} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={labelStyle}>Verification Code</label>
                <input
                  type="text" inputMode="numeric" maxLength={6} placeholder="000000"
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required
                  style={{ ...inputStyle, padding: '14px', fontSize: 24, letterSpacing: 8, textAlign: 'center', fontFamily: 'monospace' }}
                />
              </div>
              <button type="submit" disabled={loading || code.length !== 6} style={primaryBtnStyle(loading || code.length !== 6)}>
                {loading ? 'Verifying...' : 'Verify & Get API Key →'}
              </button>
            </form>

            <p style={{ textAlign: 'center', marginTop: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
              Didn't get a code?{' '}
              <button onClick={handleResend} style={{ background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', fontSize: 13, padding: 0 }}>
                Resend
              </button>
            </p>
          </div>
        </div>
      </main>
    );
  }

  // ── Signup form ───────────────────────────────────────────────────────────
  return (
    <main style={shellStyle}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <Image src="/arcflare-logo.png" alt="FlareHQ" width={52} height={52} style={{ borderRadius: 14, objectFit: 'contain', marginBottom: 16 }} />
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', margin: '0 0 8px' }}>Create Merchant Account</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>Start accepting USDC payments on Arc in minutes.</p>
        </div>

        <div style={cardStyle}>
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
              <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>❌ {error}</p>
            </div>
          )}

          <form onSubmit={handleFormSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              { label: 'Business Name', key: 'businessName', type: 'text', placeholder: 'Acme Corp' },
              { label: 'Email Address', key: 'email', type: 'email', placeholder: 'you@business.com' },
              { label: 'Password', key: 'password', type: 'password', placeholder: 'At least 8 characters' },
              { label: 'Confirm Password', key: 'confirm', type: 'password', placeholder: 'Repeat password' },
            ].map((field) => (
              <div key={field.key}>
                <label style={labelStyle}>{field.label}</label>
                <input
                  type={field.type}
                  placeholder={field.placeholder}
                  value={form[field.key as keyof typeof form]}
                  onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                  required
                  style={inputStyle}
                />
              </div>
            ))}

            <button type="submit" disabled={loading} style={primaryBtnStyle(loading)}>
              {loading ? 'Creating account...' : 'Create Account →'}
            </button>
          </form>

          <p style={{ textAlign: 'center', marginTop: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
            Already have an account?{' '}
            <a href="/merchant/login" style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>Sign in</a>
          </p>
        </div>

        <p style={{ textAlign: 'center', marginTop: 20, fontSize: 11, color: 'var(--border)', fontFamily: 'monospace', letterSpacing: 1 }}>
          FLAREHQ PAYMENT INFRASTRUCTURE • ARC TESTNET
        </p>
      </div>
    </main>
  );
}
