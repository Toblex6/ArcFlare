//src/app/escrow/page.tsx
'use client';

import DashboardSidebar from '@/src/components/DashboardSidebar';

import { useRouter } from 'next/navigation';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';

interface EscrowItem {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  depositorSCA: string;
  beneficiarySCA: string;
  status: string;
  condition: string | null;
  deadline: string | null;
  timeRemaining: number | null;
  isExpired: boolean;
  txHash: string | null;
  releaseTxHash: string | null;
  disputeTxHash: string | null;
  disputeReason: string | null;
  depositorConfirmed: boolean;
  beneficiaryConfirmed: boolean;
  explorerUrl: string | null;
  createdAt: string;
  disputedBy: string | null;
}

interface EscrowMetrics {
  total: number;
  active: number;
  released: number;
  disputed: number;
  refunded: number;
  totalLocked: number;
  totalReleased: number;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  ACTIVE: { bg: 'rgba(13,124,95,0.12)', text: '#0d7c5f', border: 'rgba(13,124,95,0.3)' },
  RELEASED: { bg: 'rgba(16,185,129,0.12)', text: '#10b981', border: 'rgba(16,185,129,0.3)' },
  DISPUTED: { bg: 'rgba(245,158,11,0.12)', text: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
  REFUNDED: { bg: 'rgba(107,114,128,0.12)', text: '#6b7280', border: 'rgba(107,114,128,0.3)' },
};

function formatTime(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

const NAV = [
  { label: 'Dashboard', href: '/merchant/dashboard' },
  { label: 'Homepage', href: '/' },
  { label: 'Transactions', href: '/transactions' },
  { label: 'Checkout', href: '/merchant/dashboard#checkout' },
  { label: 'Escrow', href: '/escrow', active: true },
  { label: 'Support', href: '/support' },
];

export default function EscrowDashboard() {
  const _router = useRouter();
  React.useEffect(() => {
    fetch('/api/merchant/me').then((r) => {
      if (r.status === 401) _router.replace('/merchant/login');
    }).catch(() => _router.replace('/merchant/login'));
  }, []);

  const [escrows, setEscrows] = useState<EscrowItem[]>([]);
  const [metrics, setMetrics] = useState<EscrowMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [selected, setSelected] = useState<EscrowItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchEscrows = async () => {
    try {
      const url = filter === 'ALL' ? '/api/escrow/list' : `/api/escrow/list?status=${filter}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setEscrows(json.escrows);
        setMetrics(json.metrics);
        setError(null);
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to load escrows.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEscrows();
    const interval = setInterval(fetchEscrows, 10000);
    return () => clearInterval(interval);
  }, [filter]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#f8fafc',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            color: '#0d7c5f',
            fontFamily: 'monospace',
            fontSize: 12,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          LOADING ESCROW LEDGER...
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: '#f8fafc',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <style>{`
        .filter-btn { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #e2e8f0; background: #fff; color: #64748b; transition: all 0.15s; }
        .filter-btn.active { background: rgba(13,124,95,0.1); border-color: #0d7c5f; color: #0d7c5f; font-weight: 600; }
        .filter-btn:hover { border-color: #0d7c5f; color: #0d7c5f; }
        .hover-row:hover { background: rgba(0,0,0,0.02); cursor: pointer; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      {/* Sidebar */}
      <DashboardSidebar active="Escrow" />

      {/* Main */}
      <main style={{ flex: 1, padding: '32px 32px', overflowX: 'hidden' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 28,
          }}
        >
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: '0 0 4px 0' }}>
              Escrow Management
            </h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
              Trustless USDC escrow on Arc Testnet via ArcFlareEscrow contract
            </p>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(13,124,95,0.08)',
              border: '1px solid rgba(13,124,95,0.2)',
              borderRadius: 20,
              padding: '5px 14px',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#0d7c5f',
                display: 'inline-block',
                animation: 'pulse 2s infinite',
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: '#0d7c5f',
                fontWeight: 600,
                fontFamily: 'monospace',
                letterSpacing: 1,
              }}
            >
              ARC TESTNET LIVE
            </span>
          </div>
        </div>

        {/* Metrics */}
        {metrics && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 14,
              marginBottom: 24,
            }}
          >
            {[
              {
                label: 'Total Locked',
                value: `${metrics.totalLocked.toFixed(2)} USDC`,
                sub: `${metrics.active} active escrows`,
                color: '#0d7c5f',
                bg: '#f0fdf4',
                border: '#bbf7d0',
              },
              {
                label: 'Total Released',
                value: `${metrics.totalReleased.toFixed(2)} USDC`,
                sub: `${metrics.released} completed`,
                color: '#16a34a',
                bg: '#f0fdf4',
                border: '#bbf7d0',
              },
              {
                label: 'Disputed',
                value: metrics.disputed.toString(),
                sub: 'Pending admin review',
                color: '#d97706',
                bg: '#fffbeb',
                border: '#fde68a',
              },
              {
                label: 'Refunded',
                value: metrics.refunded.toString(),
                sub: 'Returned to depositor',
                color: '#64748b',
                bg: '#f8fafc',
                border: '#e2e8f0',
              },
            ].map((m, i) => (
              <div
                key={i}
                style={{
                  background: m.bg,
                  border: `1px solid ${m.border}`,
                  borderRadius: 14,
                  padding: 18,
                }}
              >
                <p
                  style={{
                    fontSize: 11,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    marginBottom: 8,
                    margin: '0 0 8px 0',
                  }}
                >
                  {m.label}
                </p>
                <p
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: m.color,
                    marginBottom: 4,
                    fontFamily: 'monospace',
                    margin: '0 0 4px 0',
                  }}
                >
                  {m.value}
                </p>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>{m.sub}</p>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {['ALL', 'ACTIVE', 'RELEASED', 'DISPUTED', 'REFUNDED'].map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <button
            onClick={fetchEscrows}
            style={{
              marginLeft: 'auto',
              padding: '6px 14px',
              borderRadius: 8,
              fontSize: 12,
              cursor: 'pointer',
              border: '1px solid #e2e8f0',
              background: '#fff',
              color: '#64748b',
            }}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Table + Detail */}
        <div
          style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', gap: 20 }}
        >
          <div
            style={{
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderRadius: 16,
              padding: 24,
            }}
          >
            {error && (
              <p
                style={{
                  color: '#dc2626',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  marginBottom: 16,
                }}
              >
                ❌ {error}
              </p>
            )}
            {escrows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <p style={{ fontSize: 32, marginBottom: 12 }}>🔒</p>
                <p style={{ color: '#94a3b8', fontSize: 14 }}>No escrows found.</p>
                <p style={{ color: '#cbd5e1', fontSize: 12, marginTop: 4 }}>
                  Create an escrow via POST /api/escrow/create
                </p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                    fontFamily: 'monospace',
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                      {[
                        'Reference',
                        'Parties',
                        'Amount',
                        'Condition',
                        'Deadline',
                        'Status',
                        'Confirmations',
                      ].map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: 'left',
                            paddingBottom: 12,
                            paddingRight: 14,
                            fontSize: 10,
                            color: '#94a3b8',
                            textTransform: 'uppercase',
                            letterSpacing: 0.5,
                            fontWeight: 500,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {escrows.map((e) => {
                      const sc = STATUS_COLORS[e.status] || STATUS_COLORS.ACTIVE;
                      return (
                        <tr
                          key={e.id}
                          className="hover-row"
                          style={{ borderBottom: '1px solid #f8fafc' }}
                          onClick={() => setSelected(selected?.id === e.id ? null : e)}
                        >
                          <td style={{ padding: '14px 14px 14px 0' }}>
                            <div style={{ color: '#0d7c5f' }}>{e.reference.slice(0, 14)}...</div>
                            <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 2 }}>
                              {new Date(e.createdAt).toLocaleDateString()}
                            </div>
                          </td>
                          <td style={{ padding: '14px 14px 14px 0' }}>
                            <div style={{ color: '#0f172a' }}>
                              📤 {e.depositorSCA.slice(0, 10)}...
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 2 }}>
                              📥 {e.beneficiarySCA.slice(0, 10)}...
                            </div>
                          </td>
                          <td style={{ padding: '14px 14px 14px 0' }}>
                            <div style={{ color: '#0f172a', fontWeight: 700 }}>
                              {e.amount.toFixed(2)}
                            </div>
                            <div style={{ color: '#d97706', fontSize: 10 }}>{e.currency}</div>
                          </td>
                          <td style={{ padding: '14px 14px 14px 0', maxWidth: 140 }}>
                            <div
                              style={{ color: '#64748b', fontSize: 10, wordBreak: 'break-word' }}
                            >
                              {e.condition || 'No condition set'}
                            </div>
                          </td>
                          <td style={{ padding: '14px 14px 14px 0' }}>
                            {e.deadline ? (
                              <>
                                <div
                                  style={{
                                    color: e.isExpired ? '#dc2626' : '#0f172a',
                                    fontSize: 11,
                                  }}
                                >
                                  {e.isExpired
                                    ? '⚠ Expired'
                                    : `⏱ ${formatTime(e.timeRemaining || 0)}`}
                                </div>
                                <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 2 }}>
                                  {new Date(e.deadline).toLocaleDateString()}
                                </div>
                              </>
                            ) : (
                              <div style={{ color: '#94a3b8', fontSize: 10 }}>No deadline</div>
                            )}
                          </td>
                          <td style={{ padding: '14px 14px 14px 0' }}>
                            <span
                              style={{
                                padding: '3px 10px',
                                borderRadius: 20,
                                fontSize: 10,
                                fontWeight: 700,
                                background: sc.bg,
                                color: sc.text,
                                border: `1px solid ${sc.border}`,
                              }}
                            >
                              {e.status}
                            </span>
                          </td>
                          <td style={{ padding: '14px 0' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '2px 7px',
                                  borderRadius: 4,
                                  background: e.depositorConfirmed ? '#f0fdf4' : '#f8fafc',
                                  color: e.depositorConfirmed ? '#0d7c5f' : '#94a3b8',
                                  border: `1px solid ${e.depositorConfirmed ? '#bbf7d0' : '#e2e8f0'}`,
                                }}
                              >
                                {e.depositorConfirmed ? '✓' : '○'} Dep
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '2px 7px',
                                  borderRadius: 4,
                                  background: e.beneficiaryConfirmed ? '#f0fdf4' : '#f8fafc',
                                  color: e.beneficiaryConfirmed ? '#0d7c5f' : '#94a3b8',
                                  border: `1px solid ${e.beneficiaryConfirmed ? '#bbf7d0' : '#e2e8f0'}`,
                                }}
                              >
                                {e.beneficiaryConfirmed ? '✓' : '○'} Ben
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Detail Panel */}
          {selected && (
            <div
              style={{
                background: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: 16,
                padding: 24,
                alignSelf: 'start',
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
                <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: 0 }}>
                  Escrow Detail
                </h3>
                <button
                  onClick={() => setSelected(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: 18,
                  }}
                >
                  ✕
                </button>
              </div>
              {(() => {
                const sc = STATUS_COLORS[selected.status] || STATUS_COLORS.ACTIVE;
                return (
                  <span
                    style={{
                      padding: '4px 12px',
                      borderRadius: 20,
                      fontSize: 11,
                      fontWeight: 700,
                      background: sc.bg,
                      color: sc.text,
                      border: `1px solid ${sc.border}`,
                    }}
                  >
                    ● {selected.status}
                  </span>
                );
              })()}
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[
                  { label: 'Reference', value: selected.reference },
                  { label: 'Amount', value: `${selected.amount.toFixed(2)} ${selected.currency}` },
                  { label: 'Depositor SCA', value: selected.depositorSCA },
                  { label: 'Beneficiary SCA', value: selected.beneficiarySCA },
                  { label: 'Condition', value: selected.condition || 'None set' },
                  {
                    label: 'Deadline',
                    value: selected.deadline
                      ? new Date(selected.deadline).toLocaleString()
                      : 'None',
                  },
                  { label: 'Created', value: new Date(selected.createdAt).toLocaleString() },
                ].map((row) => (
                  <div
                    key={row.label}
                    style={{
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <p
                      style={{
                        fontSize: 10,
                        color: '#94a3b8',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        marginBottom: 4,
                        margin: '0 0 4px 0',
                      }}
                    >
                      {row.label}
                    </p>
                    <p
                      style={{
                        fontSize: 12,
                        color: '#0f172a',
                        fontFamily: 'monospace',
                        wordBreak: 'break-all',
                        margin: 0,
                      }}
                    >
                      {row.value}
                    </p>
                  </div>
                ))}
                <div
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  <p
                    style={{
                      fontSize: 10,
                      color: '#94a3b8',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 8,
                      margin: '0 0 8px 0',
                    }}
                  >
                    Confirmations
                  </p>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[
                      { label: 'Depositor', confirmed: selected.depositorConfirmed },
                      { label: 'Beneficiary', confirmed: selected.beneficiaryConfirmed },
                    ].map((c) => (
                      <div
                        key={c.label}
                        style={{
                          flex: 1,
                          textAlign: 'center',
                          padding: 8,
                          background: c.confirmed ? '#f0fdf4' : '#f8fafc',
                          borderRadius: 8,
                          border: `1px solid ${c.confirmed ? '#bbf7d0' : '#e2e8f0'}`,
                        }}
                      >
                        <p style={{ fontSize: 16, marginBottom: 4, margin: '0 0 4px 0' }}>
                          {c.confirmed ? '✅' : '⏳'}
                        </p>
                        <p
                          style={{
                            fontSize: 10,
                            color: c.confirmed ? '#0d7c5f' : '#94a3b8',
                            margin: 0,
                          }}
                        >
                          {c.label}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                {selected.explorerUrl && (
                  <a
                    href={selected.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'block',
                      textAlign: 'center',
                      padding: 10,
                      background: 'rgba(13,124,95,0.08)',
                      border: '1px solid rgba(13,124,95,0.2)',
                      borderRadius: 8,
                      color: '#0d7c5f',
                      fontSize: 12,
                      textDecoration: 'none',
                      fontWeight: 600,
                    }}
                  >
                    View on ArcScan →
                  </a>
                )}
                {selected.disputeReason && (
                  <div
                    style={{
                      background: '#fffbeb',
                      border: '1px solid #fde68a',
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <p
                      style={{
                        fontSize: 10,
                        color: '#d97706',
                        marginBottom: 4,
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        margin: '0 0 4px 0',
                      }}
                    >
                      Dispute Reason
                    </p>
                    <p style={{ fontSize: 12, color: '#0f172a', margin: 0 }}>
                      {selected.disputeReason}
                    </p>
                    {selected.disputedBy && (
                      <p
                        style={{
                          fontSize: 10,
                          color: '#94a3b8',
                          marginTop: 4,
                          margin: '4px 0 0 0',
                        }}
                      >
                        Raised by: {selected.disputedBy}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
