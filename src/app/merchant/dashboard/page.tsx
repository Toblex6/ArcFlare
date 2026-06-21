//src/app/merchant/dashboard/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

interface MerchantData {
  id: string;
  email: string;
  businessName: string;
  apiKeyHint: string;
  createdAt: string;
}

interface Stats {
  totalPayments: number;
  successfulPayments: number;
  totalVolume: number;
  successRate: number;
}

interface PaymentLink {
  reference: string;
  amount: number;
  currency: string;
  status: string;
  checkoutUrl: string;
  createdAt: string;
}

export default function MerchantDashboard() {
  const router = useRouter();
  const [merchant, setMerchant] = useState<MerchantData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [payments, setPayments] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  // Payment link creation state
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [newLink, setNewLink] = useState<PaymentLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchDashboard = async () => {
    try {
      const res = await fetch('/api/merchant/me');
      if (res.status === 401) {
        setAuthError(true);
        router.push('/merchant/login');
        return;
      }
      const data = await res.json();
      if (data.success) {
        setMerchant(data.merchant);
        setStats(data.stats);
        setPayments(data.recentPayments || []);
      }
    } catch {
      setAuthError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  const handleCreateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setLinkError('Enter a valid amount.');
      return;
    }
    setCreating(true);
    setLinkError(null);
    setNewLink(null);

    try {
      const res = await fetch('/api/merchant/payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          currency: 'USDC',
          description,
          webhookUrl: webhookUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setNewLink(data);
      setPayments((prev) => [
        {
          reference: data.reference,
          amount: data.amount,
          currency: data.currency,
          status: 'PENDING',
          checkoutUrl: data.checkoutUrl,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setAmount('');
      setDescription('');
      setWebhookUrl('');
    } catch (err: any) {
      setLinkError(err.message || 'Failed to create link.');
    } finally {
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/merchant/me', { method: 'DELETE' });
    router.push('/merchant/login');
  };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusColor = (status: string) => {
    if (status === 'SUCCESS') return '#0d7c5f';
    if (status === 'PENDING') return '#f59e0b';
    if (status === 'ATTESTATION_FAILED') return '#ef4444';
    return '#6b5a45';
  };

  const statusBg = (status: string) => {
    if (status === 'SUCCESS') return 'rgba(13,124,95,0.12)';
    if (status === 'PENDING') return 'rgba(245,158,11,0.12)';
    if (status === 'ATTESTATION_FAILED') return 'rgba(239,68,68,0.12)';
    return 'rgba(107,90,69,0.12)';
  };

  if (loading) {
    return (
      <main
        style={{
          minHeight: '100vh',
          background: '#0e0b08',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            color: '#c8975a',
            fontFamily: 'monospace',
            fontSize: 12,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          Loading merchant portal...
        </p>
      </main>
    );
  }

  if (authError || !merchant) {
    return (
      <main
        style={{
          minHeight: '100vh',
          background: '#0e0b08',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ color: '#f87171', fontFamily: 'monospace', fontSize: 13 }}>
          Session expired. Redirecting...
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0e0b08',
        color: '#f0ece6',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {/* ── TOP NAV ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          borderBottom: '1px solid #2d2015',
          padding: '14px 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={36}
            height={36}
            style={{ borderRadius: 9, objectFit: 'contain' }}
          />
          <div>
            <p style={{ color: '#f0ece6', fontSize: 14, fontWeight: 700, margin: 0 }}>ArcFlare</p>
            <p
              style={{
                color: '#6b5a45',
                fontSize: 10,
                margin: 0,
                fontFamily: 'monospace',
                letterSpacing: 1,
              }}
            >
              MERCHANT PORTAL
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <p style={{ color: '#f0ece6', fontSize: 13, fontWeight: 600, margin: 0 }}>
              {merchant.businessName}
            </p>
            <p style={{ color: '#6b5a45', fontSize: 11, margin: 0 }}>{merchant.email}</p>
          </div>
          <button
            onClick={handleLogout}
            style={{
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 8,
              padding: '6px 14px',
              color: '#f87171',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '36px 40px' }}>
        {/* ── STATS ROW ──────────────────────────────────────────────────────── */}
        {stats && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 16,
              marginBottom: 36,
            }}
          >
            {[
              {
                label: 'Total Volume',
                value: `${stats.totalVolume.toFixed(2)} USDC`,
                color: '#c8975a',
              },
              { label: 'Total Payments', value: stats.totalPayments.toString(), color: '#f0ece6' },
              { label: 'Successful', value: stats.successfulPayments.toString(), color: '#0d7c5f' },
              {
                label: 'Success Rate',
                value: `${stats.successRate}%`,
                color: stats.successRate >= 80 ? '#0d7c5f' : '#f59e0b',
              },
            ].map((s, i) => (
              <div
                key={i}
                style={{
                  background: '#1a1410',
                  border: '1px solid #2d2015',
                  borderRadius: 14,
                  padding: '20px 22px',
                }}
              >
                <p
                  style={{
                    color: '#6b5a45',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.8,
                    margin: '0 0 8px',
                  }}
                >
                  {s.label}
                </p>
                <p
                  style={{
                    color: s.color,
                    fontSize: 24,
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    margin: 0,
                  }}
                >
                  {s.value}
                </p>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
          {/* ── CREATE PAYMENT LINK ────────────────────────────────────────────── */}
          <div>
            <div
              style={{
                background: '#1a1410',
                border: '1px solid #2d2015',
                borderRadius: 20,
                padding: 28,
                marginBottom: 20,
              }}
            >
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#f0ece6', margin: '0 0 20px' }}>
                Create Payment Link
              </h2>

              <form
                onSubmit={handleCreateLink}
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      color: '#8a7560',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.8,
                      marginBottom: 6,
                    }}
                  >
                    Amount (USDC)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="e.g. 10.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    style={{
                      width: '100%',
                      background: '#251c12',
                      border: '1px solid #3d2e1a',
                      borderRadius: 10,
                      padding: '11px 14px',
                      color: '#f0ece6',
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
                      color: '#8a7560',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.8,
                      marginBottom: 6,
                    }}
                  >
                    Description (optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. License fee, API access..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#251c12',
                      border: '1px solid #3d2e1a',
                      borderRadius: 10,
                      padding: '11px 14px',
                      color: '#f0ece6',
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
                      color: '#8a7560',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.8,
                      marginBottom: 6,
                    }}
                  >
                    Webhook URL (optional)
                  </label>
                  <input
                    type="url"
                    placeholder="https://your-site.com/webhook"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#251c12',
                      border: '1px solid #3d2e1a',
                      borderRadius: 10,
                      padding: '11px 14px',
                      color: '#f0ece6',
                      fontSize: 14,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {linkError && (
                  <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {linkError}</p>
                )}

                <button
                  type="submit"
                  disabled={creating}
                  style={{
                    padding: '13px',
                    background: creating ? 'rgba(200,151,90,0.3)' : '#c8975a',
                    color: creating ? 'rgba(14,11,8,0.5)' : '#0e0b08',
                    border: 'none',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 800,
                    cursor: creating ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {creating ? 'Generating...' : 'Generate Payment Link →'}
                </button>
              </form>

              {/* New link result */}
              {newLink && (
                <div
                  style={{
                    marginTop: 20,
                    background: 'rgba(13,124,95,0.08)',
                    border: '1px solid rgba(13,124,95,0.2)',
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <p
                    style={{
                      color: '#0d7c5f',
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: 1,
                      margin: '0 0 10px',
                    }}
                  >
                    ✓ Link Created
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <p
                      style={{
                        color: '#c8975a',
                        fontSize: 12,
                        fontFamily: 'monospace',
                        margin: 0,
                        flex: 1,
                        wordBreak: 'break-all',
                      }}
                    >
                      {newLink.checkoutUrl}
                    </p>
                    <button
                      onClick={() => copyLink(newLink.checkoutUrl)}
                      style={{
                        flexShrink: 0,
                        background: copied ? 'rgba(13,124,95,0.2)' : 'rgba(200,151,90,0.15)',
                        border: `1px solid ${copied ? 'rgba(13,124,95,0.3)' : 'rgba(200,151,90,0.3)'}`,
                        borderRadius: 8,
                        padding: '6px 12px',
                        color: copied ? '#0d7c5f' : '#c8975a',
                        fontSize: 11,
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <p style={{ color: '#6b5a45', fontSize: 11, margin: '8px 0 0' }}>
                    Amount: {newLink.amount} USDC • Ref: {newLink.reference}
                  </p>
                </div>
              )}
            </div>

            {/* ── API KEY INFO ────────────────────────────────────────────────── */}
            <div
              style={{
                background: '#1a1410',
                border: '1px solid #2d2015',
                borderRadius: 20,
                padding: 24,
              }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 14px' }}>
                Your API Key
              </h3>
              <div
                style={{
                  background: '#0e0b08',
                  border: '1px solid #3d2e1a',
                  borderRadius: 10,
                  padding: '12px 14px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  color: '#c8975a',
                  marginBottom: 10,
                }}
              >
                {merchant.apiKeyHint}
              </div>
              <p style={{ color: '#4b4035', fontSize: 11, margin: 0 }}>
                Full key was shown at signup only. Use it in the{' '}
                <code style={{ color: '#8a7560' }}>x-api-key</code> header to call ArcFlare APIs.
              </p>
              <div style={{ marginTop: 14, background: '#251c12', borderRadius: 10, padding: 12 }}>
                <p
                  style={{
                    color: '#6b5a45',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    margin: '0 0 6px',
                  }}
                >
                  Quick start
                </p>
                <p
                  style={{
                    color: '#8a7560',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    margin: 0,
                    lineHeight: 1.7,
                  }}
                >
                  POST /api/payments/initialize
                  <br />
                  x-api-key: {merchant.apiKeyHint}
                  <br />
                  &#123; "amount": "10", "currency": "USDC", "merchant": "{merchant.businessName}"
                  &#125;
                </p>
              </div>
            </div>
          </div>

          {/* ── PAYMENT HISTORY ────────────────────────────────────────────────── */}
          <div
            style={{
              background: '#1a1410',
              border: '1px solid #2d2015',
              borderRadius: 20,
              padding: 28,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 20,
              }}
            >
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#f0ece6', margin: 0 }}>
                Payment History
              </h2>
              <button
                onClick={fetchDashboard}
                style={{
                  background: 'transparent',
                  border: '1px solid #3d2e1a',
                  borderRadius: 8,
                  padding: '5px 12px',
                  color: '#6b5a45',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                ↻ Refresh
              </button>
            </div>

            {payments.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <p style={{ fontSize: 28, marginBottom: 10 }}>🔗</p>
                <p style={{ color: '#4b4035', fontSize: 14 }}>No payments yet.</p>
                <p style={{ color: '#3d2e1a', fontSize: 12, marginTop: 4 }}>
                  Create your first payment link to get started.
                </p>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  maxHeight: 520,
                  overflowY: 'auto',
                }}
              >
                {payments.map((p, i) => (
                  <div
                    key={i}
                    style={{
                      background: '#251c12',
                      border: '1px solid #3d2e1a',
                      borderRadius: 12,
                      padding: '14px 16px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        marginBottom: 8,
                      }}
                    >
                      <p
                        style={{
                          color: '#c8975a',
                          fontSize: 12,
                          fontFamily: 'monospace',
                          margin: 0,
                        }}
                      >
                        {p.reference.slice(0, 20)}...
                      </p>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 10px',
                          borderRadius: 20,
                          background: statusBg(p.status),
                          color: statusColor(p.status),
                        }}
                      >
                        {p.status}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <p
                        style={{
                          color: '#f0ece6',
                          fontSize: 16,
                          fontWeight: 700,
                          fontFamily: 'monospace',
                          margin: 0,
                        }}
                      >
                        {p.amount}{' '}
                        <span style={{ color: '#c8975a', fontSize: 12 }}>{p.currency}</span>
                      </p>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => copyLink(p.checkoutUrl)}
                          style={{
                            background: 'transparent',
                            border: '1px solid #3d2e1a',
                            borderRadius: 6,
                            padding: '4px 10px',
                            color: '#8a7560',
                            fontSize: 10,
                            cursor: 'pointer',
                          }}
                        >
                          Copy link
                        </button>
                        <a
                          href={p.checkoutUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            background: 'transparent',
                            border: '1px solid #3d2e1a',
                            borderRadius: 6,
                            padding: '4px 10px',
                            color: '#c8975a',
                            fontSize: 10,
                            cursor: 'pointer',
                            textDecoration: 'none',
                          }}
                        >
                          View →
                        </a>
                      </div>
                    </div>
                    <p
                      style={{
                        color: '#4b4035',
                        fontSize: 10,
                        margin: '6px 0 0',
                        fontFamily: 'monospace',
                      }}
                    >
                      {new Date(p.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
