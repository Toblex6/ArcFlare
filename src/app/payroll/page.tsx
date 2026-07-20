// src/app/payroll/page.tsx
// Frontend for Batch Payroll — pay N recipients in one call.

'use client';

import { useRouter } from 'next/navigation';

import React, { useState } from 'react';
import Image from 'next/image';


const NAV = [
  { label: 'Dashboard', href: '/merchant/dashboard' },
  { label: 'Homepage', href: '/' },
  { label: 'Transactions', href: '/transactions' },
  { label: 'Checkout', href: '/merchant/dashboard#checkout' },
  { label: 'Escrow', href: '/escrow' },
  { label: 'Agents', href: '/agents' },
  { label: 'Agent Wallets', href: '/agent-wallets' },
  { label: 'Jobs', href: '/jobs' },
  { label: 'Nanopayments', href: '/nano' },
  { label: 'Payroll', href: '/payroll', active: true },
  { label: 'Scheduled', href: '/scheduled' },
  { label: 'Support', href: '/support' },
];

interface Recipient {
  recipientSCA: string;
  amount: string;
  label: string;
}

export default function PayrollPage() {
  const _router = useRouter();
  React.useEffect(() => {
    fetch('/api/merchant/me').then((r) => {
      if (r.status === 401) _router.replace('/merchant/login');
    }).catch(() => _router.replace('/merchant/login'));
  }, []);

  const [activeTab, setActiveTab] = useState<'run' | 'lookup'>('run');

  const [payerSCA, setPayerSCA] = useState('0x7a8214dad7630a7a39054e0121acdbc7a65821c9');
  const [payerWalletId, setPayerWalletId] = useState('58ab0223-cad0-5128-896e-a88d6f217b43');
  const [recipients, setRecipients] = useState<Recipient[]>([
    { recipientSCA: '', amount: '', label: '' },
  ]);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<any>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [lookupRef, setLookupRef] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const addRecipient = () =>
    setRecipients([...recipients, { recipientSCA: '', amount: '', label: '' }]);
  const removeRecipient = (i: number) => setRecipients(recipients.filter((_, idx) => idx !== i));
  const updateRecipient = (i: number, field: keyof Recipient, value: string) => {
    const updated = [...recipients];
    updated[i][field] = value;
    setRecipients(updated);
  };

  const totalAmount = recipients.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

  const runPayroll = async () => {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const validRecipients = recipients.filter((r) => r.recipientSCA && r.amount);
      if (validRecipients.length === 0)
        throw new Error('Add at least one recipient with an address and amount.');

      const res = await fetch('/api/payroll/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payerSCA, payerWalletId, recipients: validRecipients }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setRunResult(data);
    } catch (e: any) {
      setRunError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const lookupBatch = async () => {
    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const res = await fetch(`/api/payroll/run?batchRef=${lookupRef}`, {
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setLookupResult(data.batch);
    } catch (e: any) {
      setLookupError(e.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const S = {
    page: {
      display: 'flex',
      minHeight: '100vh',
      background: '#0e0b08',
      fontFamily: 'Inter, system-ui, sans-serif',
      color: '#f0ece6',
    },
    aside: {
      width: 220,
      minHeight: '100vh',
      background: '#1a1410',
      display: 'flex',
      flexDirection: 'column' as const,
      padding: '24px 14px',
      flexShrink: 0,
      position: 'sticky' as const,
      top: 0,
      height: '100vh',
      overflowY: 'auto' as const,
      borderRight: '1px solid #2d2015',
    },
    main: { flex: 1, padding: '32px', overflowX: 'hidden' as const },
    card: {
      background: '#1a1410',
      border: '1px solid #2d2015',
      borderRadius: 16,
      padding: 24,
      marginBottom: 20,
    },
    input: {
      width: '100%',
      padding: '10px 14px',
      background: '#251c12',
      border: '1px solid #3d2e1a',
      borderRadius: 10,
      color: '#f0ece6',
      fontSize: 13,
      fontFamily: 'monospace',
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    btn: (disabled = false) => ({
      padding: '12px 24px',
      background: disabled ? 'rgba(200,151,90,0.3)' : '#c8975a',
      color: disabled ? 'rgba(14,11,8,0.5)' : '#0e0b08',
      border: 'none',
      borderRadius: 10,
      fontWeight: 700,
      fontSize: 13,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }),
    tab: (active: boolean) => ({
      padding: '8px 16px',
      borderRadius: 8,
      fontSize: 12,
      cursor: 'pointer',
      border: `1px solid ${active ? '#c8975a' : '#2d2015'}`,
      background: active ? 'rgba(200,151,90,0.1)' : 'transparent',
      color: active ? '#c8975a' : '#6b5a45',
      fontWeight: active ? 700 : 400,
    }),
    label: {
      fontSize: 10,
      color: '#6b5a45',
      textTransform: 'uppercase' as const,
      letterSpacing: 1,
      marginBottom: 4,
      display: 'block' as const,
    },
  };

  return (
    <div style={S.page}>
      <aside style={S.aside}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 36,
            paddingLeft: 6,
          }}
        >
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={36}
            height={36}
            style={{ borderRadius: 8, objectFit: 'contain' }}
          />
          <div>
            <p style={{ color: '#f0ece6', fontSize: 14, fontWeight: 700, margin: 0 }}>ArcFlare</p>
            <p style={{ color: '#6b5a45', fontSize: 9, margin: 0 }}>
              Stablecoin Payment Infrastructure
            </p>
          </div>
        </div>
        <nav
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            flex: 1,
            overflowY: 'auto' as const,
          }}
        >
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 9,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 500,
                background: (item as any).active ? 'rgba(200,151,90,0.15)' : 'transparent',
                color: (item as any).active ? '#c8975a' : '#6b5a45',
                border: (item as any).active
                  ? '1px solid rgba(200,151,90,0.25)'
                  : '1px solid transparent',
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      <main style={S.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>
            Batch Payroll
          </h1>
          <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>
            Pay any number of recipients in a single onchain batch
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {(['run', 'lookup'] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === 'run' ? '⚡ Run Payroll' : '🔍 Look Up Batch'}
            </button>
          ))}
        </div>

        {activeTab === 'run' && (
          <div style={S.card}>
            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}
            >
              <div>
                <span style={S.label}>Payer SCA</span>
                <input
                  style={S.input}
                  value={payerSCA}
                  onChange={(e) => setPayerSCA(e.target.value)}
                />
              </div>
              <div>
                <span style={S.label}>Payer Circle Wallet ID</span>
                <input
                  style={S.input}
                  value={payerWalletId}
                  onChange={(e) => setPayerWalletId(e.target.value)}
                />
              </div>
            </div>

            <p
              style={{
                color: '#c8975a',
                fontSize: 12,
                fontWeight: 700,
                margin: '0 0 12px',
                textTransform: 'uppercase' as const,
                letterSpacing: 1,
              }}
            >
              Recipients
            </p>

            {recipients.map((r, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr auto',
                  gap: 8,
                  marginBottom: 8,
                  alignItems: 'center',
                }}
              >
                <input
                  style={S.input}
                  value={r.recipientSCA}
                  onChange={(e) => updateRecipient(i, 'recipientSCA', e.target.value)}
                  placeholder="0xRecipientAddress"
                />
                <input
                  style={S.input}
                  value={r.amount}
                  onChange={(e) => updateRecipient(i, 'amount', e.target.value)}
                  placeholder="Amount USDC"
                />
                <input
                  style={S.input}
                  value={r.label}
                  onChange={(e) => updateRecipient(i, 'label', e.target.value)}
                  placeholder="EMP-001"
                />
                <button
                  onClick={() => removeRecipient(i)}
                  style={{
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 8,
                    color: '#f87171',
                    padding: '10px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              </div>
            ))}

            <button
              onClick={addRecipient}
              style={{
                marginTop: 8,
                marginBottom: 20,
                padding: '8px 16px',
                background: 'transparent',
                border: '1px dashed #3d2e1a',
                borderRadius: 8,
                color: '#6b5a45',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              + Add Recipient
            </button>

            <div
              style={{
                background: 'rgba(200,151,90,0.06)',
                border: '1px solid rgba(200,151,90,0.2)',
                borderRadius: 10,
                padding: '12px 16px',
                marginBottom: 16,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ color: '#8a7560', fontSize: 13 }}>Total Payroll</span>
              <span style={{ color: '#c8975a', fontWeight: 700, fontFamily: 'monospace' }}>
                {totalAmount.toFixed(6)} USDC —{' '}
                {recipients.filter((r) => r.recipientSCA && r.amount).length} recipients
              </span>
            </div>

            <button style={S.btn(running)} disabled={running} onClick={runPayroll}>
              {running ? 'Processing payroll onchain...' : '⚡ Run Payroll'}
            </button>

            {runError && (
              <p style={{ color: '#f87171', fontSize: 12, marginTop: 10 }}>❌ {runError}</p>
            )}

            {runResult && (
              <div
                style={{
                  marginTop: 16,
                  background: 'rgba(16,185,129,0.06)',
                  border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: 14,
                  padding: 20,
                }}
              >
                <p style={{ color: '#10b981', fontWeight: 700, fontSize: 14, margin: '0 0 4px' }}>
                  {runResult.status}
                </p>
                <p style={{ color: '#f0ece6', fontSize: 12, margin: '0 0 14px' }}>
                  {runResult.message}
                </p>
                {runResult.results.map((r: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderBottom: '1px solid #2d2015',
                    }}
                  >
                    <span style={{ color: '#f0ece6', fontSize: 11, fontFamily: 'monospace' }}>
                      {r.recipientSCA.slice(0, 10)}... {r.label ? `(${r.label})` : ''}
                    </span>
                    <span
                      style={{
                        color: r.status === 'SUCCESS' ? '#10b981' : '#f87171',
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      {r.status === 'SUCCESS' ? `✅ ${r.amount} USDC` : '❌ Failed'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'lookup' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 16px' }}>
              Look Up Payroll Batch
            </h3>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <input
                style={{ ...S.input, flex: 1 }}
                value={lookupRef}
                onChange={(e) => setLookupRef(e.target.value)}
                placeholder="payroll_xxx"
              />
              <button style={S.btn(lookupLoading)} disabled={lookupLoading} onClick={lookupBatch}>
                {lookupLoading ? 'Loading...' : 'Look Up'}
              </button>
            </div>
            {lookupError && <p style={{ color: '#f87171', fontSize: 12 }}>❌ {lookupError}</p>}
            {lookupResult && (
              <pre
                style={{
                  color: '#f0ece6',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap' as const,
                  background: '#251c12',
                  borderRadius: 10,
                  padding: 16,
                }}
              >
                {JSON.stringify(lookupResult, null, 2)}
              </pre>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
