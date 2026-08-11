'use client';

// src/app/merchant/forgot-password/page.tsx

import React, { useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--surface-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 'clamp(11px, 1.4vw, 12px) 14px',
  color: 'var(--text)',
  fontSize: 'clamp(13px, 1.1vw, 14px)',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  color: 'var(--text-secondary)',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.8,
  marginBottom: 6,
};

export default function ForgotPassword() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'reset' | 'done'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/merchant/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setInfo(data.message);
      setStep('reset');
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/merchant/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, newPassword }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStep('done');
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--background)',
        color: 'var(--text)',
        fontFamily: 'Inter, system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(16px, 4vw, 24px)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 'clamp(24px, 4vw, 36px)' }}>
          <Image
            src="/arcflare-logo.png.png"
            alt="FlareHQ"
            width={52}
            height={52}
            style={{ borderRadius: 14, objectFit: 'contain', marginBottom: 16 }}
          />
          <h1 style={{ fontSize: 'clamp(20px, 3vw, 26px)', fontWeight: 800, color: 'var(--text)', margin: '0 0 8px' }}>
            {step === 'done' ? 'Password Updated' : 'Reset Password'}
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'clamp(12px, 1.2vw, 14px)', margin: 0 }}>
            {step === 'request' && "Enter your email and we'll send you a reset code."}
            {step === 'reset' && `Check ${email} for a 6-digit code.`}
            {step === 'done' && 'You can sign in with your new password now.'}
          </p>
        </div>

        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 24,
            padding: 'clamp(24px, 4vw, 36px)',
            boxSizing: 'border-box',
          }}
        >
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
              <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0, wordBreak: 'break-word' }}>❌ {error}</p>
            </div>
          )}
          {info && step === 'reset' && (
            <div style={{ background: 'rgba(13,124,95,0.08)', border: '1px solid rgba(13,124,95,0.2)', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
              <p style={{ color: 'var(--success)', fontSize: 13, margin: 0, wordBreak: 'break-word' }}>✓ {info}</p>
            </div>
          )}

          {step === 'request' && (
            <form onSubmit={handleRequest} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={labelStyle}>Email Address</label>
                <input
                  type="email"
                  placeholder="you@business.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={inputStyle}
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                style={{
                  marginTop: 8,
                  padding: 'clamp(12px, 1.8vw, 14px)',
                  background: loading ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
                  color: loading ? 'rgba(14,11,8,0.5)' : 'var(--background)',
                  border: 'none',
                  borderRadius: 12,
                  fontSize: 'clamp(13px, 1.3vw, 15px)',
                  fontWeight: 800,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  boxSizing: 'border-box',
                }}
              >
                {loading ? 'Sending...' : 'Send Reset Code →'}
              </button>
            </form>
          )}

          {step === 'reset' && (
            <form onSubmit={handleReset} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={labelStyle}>Reset Code</label>
                <input
                  type="text"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: 2, textAlign: 'center' }}
                  maxLength={6}
                />
              </div>
              <div>
                <label style={labelStyle}>New Password</label>
                <input
                  type="password"
                  placeholder="At least 8 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Confirm New Password</label>
                <input
                  type="password"
                  placeholder="Repeat your new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  style={inputStyle}
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                style={{
                  marginTop: 8,
                  padding: 'clamp(12px, 1.8vw, 14px)',
                  background: loading ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
                  color: loading ? 'rgba(14,11,8,0.5)' : 'var(--background)',
                  border: 'none',
                  borderRadius: 12,
                  fontSize: 'clamp(13px, 1.3vw, 15px)',
                  fontWeight: 800,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  boxSizing: 'border-box',
                }}
              >
                {loading ? 'Updating...' : 'Reset Password →'}
              </button>
              <button
                type="button"
                onClick={() => setStep('request')}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                ← Use a different email
              </button>
            </form>
          )}

          {step === 'done' && (
            <button
              onClick={() => router.push('/merchant/login')}
              style={{
                width: '100%',
                padding: 'clamp(12px, 1.8vw, 14px)',
                background: 'var(--primary)',
                color: 'var(--background)',
                border: 'none',
                borderRadius: 12,
                fontSize: 'clamp(13px, 1.3vw, 15px)',
                fontWeight: 800,
                cursor: 'pointer',
                boxSizing: 'border-box',
              }}
            >
              Continue to Login →
            </button>
          )}

          {step !== 'done' && (
            <p style={{ textAlign: 'center', marginTop: 20, color: 'var(--text-secondary)', fontSize: 'clamp(11px, 1vw, 13px)' }}>
              Remembered it?{' '}
              <a href="/merchant/login" style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>
                Sign in
              </a>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
