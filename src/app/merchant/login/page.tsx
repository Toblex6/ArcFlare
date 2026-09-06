'use client';

//src/app/merchant/login/page.tsx

import React, { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

// src/app/merchant/login/page.tsx
//
// returnTo support: the public-browse login gate (/login?returnTo=… — see
// src/lib/auth/returnTo.ts) forwards here with the original path preserved,
// so signing in lands the user back where the gated action happened.

export default function MerchantLogin() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/merchant/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // Only honour same-origin relative returnTo paths — never redirect
      // off-site.
      const raw = searchParams.get('returnTo') || '';
      const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/merchant/dashboard';
      router.push(returnTo);
    } catch (err: any) {
      setError(err.message || 'Login failed.');
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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      {/* Shared header treatment — logo + minimal nav for visual continuity
          with the homepage (trimmed; the form itself stays focused). */}
      <header
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
        }}
      >
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <Image
            src="/arcflare-logo.png"
            alt="FlareHQ"
            width={32}
            height={32}
            style={{ borderRadius: 8 }}
          />
          <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.01em' }}>FlareHQ</span>
        </Link>
        <Link
          href="/"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textDecoration: 'none',
          }}
        >
          ← Back to home
        </Link>
      </header>

      <div style={{ width: '100%', maxWidth: 420, marginTop: 48 }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <Image
            src="/arcflare-logo.png"
            alt="FlareHQ"
            width={52}
            height={52}
            style={{ borderRadius: 14, objectFit: 'contain', marginBottom: 16 }}
          />
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', margin: '0 0 8px' }}>
            Merchant Login
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>
            Sign in to your FlareHQ merchant account.
          </p>
        </div>

        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 24,
            padding: 36,
          }}
        >
          {error && (
            <div
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 12,
                padding: '12px 16px',
                marginBottom: 20,
              }}
            >
              <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>❌ {error}</p>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div>
              <label
                style={{
                  display: 'block',
                  color: 'var(--text-secondary)',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                  marginBottom: 6,
                }}
              >
                Email Address
              </label>
              <input
                type="email"
                placeholder="you@business.com"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                required
                style={{
                  width: '100%',
                  background: 'var(--surface-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  color: 'var(--text)',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: 'block',
                  color: 'var(--text-secondary)',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                  marginBottom: 6,
                }}
              >
                Password
              </label>
              <input
                type="password"
                placeholder="Your password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
                style={{
                  width: '100%',
                  background: 'var(--surface-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  color: 'var(--text)',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ textAlign: 'right', marginTop: -6 }}>
              <a
                href="/merchant/forgot-password"
                style={{ color: 'var(--text-secondary)', fontSize: 12, textDecoration: 'none' }}
              >
                Forgot password?
              </a>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: 8,
                padding: '14px',
                background: loading ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
                color: loading ? 'rgba(14,11,8,0.5)' : 'var(--background)',
                border: 'none',
                borderRadius: 12,
                fontSize: 15,
                fontWeight: 800,
                cursor: loading ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {loading ? 'Signing in...' : 'Sign In →'}
            </button>
          </form>

          <p style={{ textAlign: 'center', marginTop: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
            No account yet?{' '}
            <a
              href="/merchant/signup"
              style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}
            >
              Create one free
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
