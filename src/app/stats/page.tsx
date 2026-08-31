'use client';

// src/app/stats/page.tsx
// Public analytics dashboard — genuinely safe to be public, since it only
// ever shows platform-wide totals (see /api/stats/public), never any
// individual merchant's or consumer's data.

import React, { useEffect, useState } from 'react';
import Image from 'next/image';

interface Metrics {
  totalVolume: number;
  totalTransactions: number;
  successCount: number;
  successRate: number;
  totalEscrows: number;
  totalLocked: number;
  totalReleased: number;
  totalAgents: number;
}

export default function PublicStatsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stats/public');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not load stats.');

      setMetrics({
        totalVolume: data.data.totalVolume,
        totalTransactions: data.data.totalTransactions,
        successCount: Math.round((data.data.successRate / 100) * data.data.totalTransactions),
        successRate: data.data.successRate,
        totalEscrows: data.data.totalEscrows,
        totalLocked: data.data.totalLocked,
        totalReleased: data.data.totalReleased,
        totalAgents: data.data.totalAgents,
      });

      setLastUpdated(new Date().toLocaleString());
    } catch (e: any) {
      setError('Unable to load live stats right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 60000); // refresh every 60s
    return () => clearInterval(interval);
  }, []);

  const S = {
    page: {
      minHeight: '100vh',
      background: '#0e0b08',
      color: '#f0ece6',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '0 0 60px',
    },
    header: {
      borderBottom: '1px solid #2d2015',
      padding: '20px 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      maxWidth: 1000,
      margin: '0 auto',
    },
    container: { maxWidth: 1000, margin: '0 auto', padding: '40px 24px' },
    card: { background: '#1a1410', border: '1px solid #2d2015', borderRadius: 18, padding: 28 },
    statCard: {
      background: '#1a1410',
      border: '1px solid #2d2015',
      borderRadius: 16,
      padding: 24,
      textAlign: 'center' as const,
    },
    statValue: {
      fontSize: 36,
      fontWeight: 800,
      color: '#c8975a',
      fontFamily: 'monospace',
      margin: '0 0 6px',
    },
    statLabel: {
      fontSize: 12,
      color: '#6b5a45',
      textTransform: 'uppercase' as const,
      letterSpacing: 1,
      margin: 0,
    },
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image
            src="/arcflare-logo.png"
            alt="FlareHQ"
            width={36}
            height={36}
            style={{ borderRadius: 8, objectFit: 'contain' }}
          />
          <div>
            <p style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>FlareHQ</p>
            <p style={{ fontSize: 10, color: '#6b5a45', margin: 0 }}>
              Public Analytics — Arc Testnet
            </p>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: '#251c12',
            border: '1px solid #3d2e1a',
            borderRadius: 20,
            padding: '6px 14px',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#10b981',
              display: 'inline-block',
            }}
          />
          <span
            style={{ fontSize: 10, color: '#10b981', fontWeight: 600, fontFamily: 'monospace' }}
          >
            LIVE — Arc Testnet
          </span>
        </div>
      </header>

      <div style={S.container}>
        <div style={{ marginBottom: 36, textAlign: 'center' }}>
          <h1 style={{ fontSize: 32, fontWeight: 800, margin: '0 0 8px' }}>
            FlareHQ Network Stats
          </h1>
          <p style={{ color: '#6b5a45', fontSize: 14, margin: 0 }}>
            Real-time onchain metrics from FlareHQ's payment infrastructure on Arc Testnet
          </p>
        </div>

        {loading && !metrics && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <p style={{ color: '#6b5a45', fontFamily: 'monospace' }}>Loading live metrics...</p>
          </div>
        )}

        {error && (
          <div
            style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 14,
              padding: 20,
              textAlign: 'center',
              marginBottom: 24,
            }}
          >
            <p style={{ color: '#f87171', margin: 0 }}>{error}</p>
          </div>
        )}

        {metrics && (
          <>
            {/* Top stats grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 16,
                marginBottom: 32,
              }}
            >
              <div style={S.statCard}>
                <p style={S.statValue}>{metrics.totalVolume}</p>
                <p style={S.statLabel}>USDC Volume Settled</p>
              </div>
              <div style={S.statCard}>
                <p style={S.statValue}>{metrics.totalTransactions}</p>
                <p style={S.statLabel}>Total Transactions</p>
              </div>
              <div style={S.statCard}>
                <p style={S.statValue}>{metrics.successRate}%</p>
                <p style={S.statLabel}>Success Rate</p>
              </div>
              <div style={S.statCard}>
                <p style={S.statValue}>{metrics.totalAgents}</p>
                <p style={S.statLabel}>ERC-8004 Agents</p>
              </div>
            </div>

            {/* Escrow stats */}
            <div style={{ ...S.card, marginBottom: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#c8975a', margin: '0 0 16px' }}>
                🔒 Trustless Escrow
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                <div>
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: '#f0ece6',
                      margin: '0 0 4px',
                      fontFamily: 'monospace',
                    }}
                  >
                    {metrics.totalEscrows}
                  </p>
                  <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>Total Escrows</p>
                </div>
                <div>
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: '#06b6d4',
                      margin: '0 0 4px',
                      fontFamily: 'monospace',
                    }}
                  >
                    {metrics.totalLocked} USDC
                  </p>
                  <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>Currently Locked</p>
                </div>
                <div>
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: '#10b981',
                      margin: '0 0 4px',
                      fontFamily: 'monospace',
                    }}
                  >
                    {metrics.totalReleased} USDC
                  </p>
                  <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>Released</p>
                </div>
              </div>
            </div>

            {/* Contracts */}
            <div style={{ ...S.card, marginBottom: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#c8975a', margin: '0 0 16px' }}>
                📜 Deployed Contracts — Arc Testnet
              </h3>
              {[
                {
                  name: 'ArcFlareEscrow.sol',
                  address: '0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F',
                },
                {
                  name: 'ArcFlareStream.sol',
                  address: '0xd8ca3Bbc212F36666145fAa487D45742eA04A52B',
                },
              ].map((c) => (
                <div
                  key={c.address}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 0',
                    borderBottom: '1px solid #2d2015',
                  }}
                >
                  <span style={{ fontSize: 13, color: '#f0ece6', fontWeight: 600 }}>{c.name}</span>
                  <a
                    href={`https://testnet.arcscan.app/address/${c.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11, color: '#c8975a', fontFamily: 'monospace' }}
                  >
                    {c.address.slice(0, 10)}...{c.address.slice(-6)} ↗
                  </a>
                </div>
              ))}
            </div>

            {/* Circle integration */}
            <div style={S.card}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#c8975a', margin: '0 0 16px' }}>
                ⚡ Circle Products Integrated
              </h3>
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 10 }}>
                {[
                  'CCTP V2',
                  'Programmable Wallets',
                  'Smart Contract Accounts',
                  'Iris API V2',
                  'Webhooks',
                  'Gateway Nanopayments',
                  'Agent Wallets',
                ].map((p) => (
                  <span
                    key={p}
                    style={{
                      fontSize: 11,
                      padding: '6px 14px',
                      borderRadius: 20,
                      background: 'rgba(200,151,90,0.1)',
                      border: '1px solid rgba(200,151,90,0.25)',
                      color: '#c8975a',
                      fontWeight: 600,
                    }}
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        <p
          style={{
            textAlign: 'center',
            marginTop: 32,
            fontSize: 11,
            color: '#3d2e1a',
            fontFamily: 'monospace',
          }}
        >
          Last updated: {lastUpdated} — Auto-refreshes every 60s — Powered by Circle CCTP V2 on Arc
          Testnet
        </p>
      </div>
    </div>
  );
}
