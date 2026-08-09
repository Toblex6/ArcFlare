// src/app/merchant/settings/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import DashboardSidebar from '@/components/DashboardSidebar';
import WalletConnectPanel from '@/components/WalletConnectPanel';
import PendingSignaturesPanel from '@/components/PendingSignaturesPanel';

interface WalletInfo {
  walletProvider: string;
  walletAddress: string | null;
}

const EXTERNAL_KINDS = new Set(['METAMASK', 'WALLETCONNECT', 'COINBASE']);

const WALLET_LABELS: Record<string, string> = {
  CIRCLE: 'Circle-Managed Wallet',
  METAMASK: 'MetaMask',
  WALLETCONNECT: 'WalletConnect',
  COINBASE: 'Coinbase Wallet',
};

const styles = {
  page: { display: 'flex', minHeight: '100vh', background: 'var(--background)', color: 'var(--text)' } as React.CSSProperties,
  main: { flex: 1, padding: 'clamp(16px, 4vw, 32px)', maxWidth: 720, width: '100%', boxSizing: 'border-box' as const },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: 'clamp(16px, 3vw, 24px)',
    marginBottom: 20,
  } as React.CSSProperties,
  label: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
    margin: '0 0 6px',
  },
  sectionTitle: { fontSize: 'clamp(14px, 1.3vw, 16px)', fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' },
  sectionSub: { fontSize: 'clamp(11px, 1vw, 13px)', color: 'var(--text-secondary)', margin: '0 0 16px' },
};

export default function MerchantSettings() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmSwitchToCircle, setConfirmSwitchToCircle] = useState(false);

  const refetchWallet = () => {
    fetch('/api/merchant/wallet')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setWallet(data.wallet);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetch('/api/merchant/wallet')
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) {
          router.replace('/merchant/login');
          return;
        }
        setWallet(data.wallet);
      })
      .catch(() => router.replace('/merchant/login'))
      .finally(() => setCheckingAuth(false));
  }, [router]);

  const switchToCircle = async () => {
    setSwitching(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/merchant/wallet', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletProvider: 'CIRCLE' }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setWallet(data.wallet);
      setSuccess(data.message);
      setConfirmSwitchToCircle(false);
    } catch (err: any) {
      setError(err.message || 'Could not switch wallet.');
    } finally {
      setSwitching(false);
    }
  };

  if (checkingAuth || !wallet) {
    return (
      <div style={styles.page}>
        <DashboardSidebar active="Settings" />
        <main style={{ ...styles.main, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading settings...</p>
        </main>
      </div>
    );
  }

  const isExternal = EXTERNAL_KINDS.has(wallet.walletProvider);

  return (
    <div style={styles.page}>
      <DashboardSidebar active="Settings" />
      <main style={styles.main}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, margin: '0 0 4px' }}>Payout Settings</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'clamp(12px, 1vw, 13px)', margin: 0 }}>
            Control where your payments settle.
          </p>
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
            <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0, wordBreak: 'break-word' }}>❌ {error}</p>
          </div>
        )}
        {success && (
          <div style={{ background: 'rgba(13,124,95,0.08)', border: '1px solid rgba(13,124,95,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
            <p style={{ color: 'var(--success)', fontSize: 13, margin: 0, wordBreak: 'break-word' }}>✓ {success}</p>
          </div>
        )}

        {/* Current wallet */}
        <div style={styles.card}>
          <p style={styles.label}>Current Payout Method</p>
          <p style={{ fontSize: 'clamp(15px, 1.4vw, 16px)', fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>
            {WALLET_LABELS[wallet.walletProvider] || wallet.walletProvider}
          </p>
          {wallet.walletAddress && (
            <p
              style={{
                fontFamily: 'monospace',
                fontSize: 'clamp(11px, 1vw, 13px)',
                color: 'var(--text)',
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 12px',
                wordBreak: 'break-all',
                margin: 0,
              }}
            >
              {wallet.walletAddress}
            </p>
          )}
        </div>

        {/* Connect an external wallet */}
        <div style={styles.card}>
          <h3 style={styles.sectionTitle}>
            {isExternal ? 'Reconnect or Switch Wallet' : 'Connect Your Own Wallet'}
          </h3>
          <p style={styles.sectionSub}>
            {isExternal
              ? 'Your payouts settle directly to your connected wallet. Connect a different one below to switch.'
              : 'Payments settle directly to an address you control — no withdrawal step needed. You\'ll sign a message to prove you own it; we never see your private key.'}
          </p>
          <WalletConnectPanel onConnected={refetchWallet} />
        </div>

        {/* Pending signatures — only meaningful for external wallets */}
        {isExternal && (
          <div style={styles.card}>
            <h3 style={styles.sectionTitle}>Pending Approvals</h3>
            <p style={styles.sectionSub}>
              Some actions (payroll, escrow, streams) need your wallet's signature since you're not on a Circle-managed wallet. Approve them here.
            </p>
            <PendingSignaturesPanel />
          </div>
        )}

        {/* Switch back to Circle */}
        {isExternal && (
          <div style={styles.card}>
            <h3 style={styles.sectionTitle}>Switch to a Managed Wallet</h3>
            <p style={styles.sectionSub}>
              We'll create a new Circle-managed wallet for you. Actions complete instantly again — no more signing required.
            </p>
            {!confirmSwitchToCircle ? (
              <button
                onClick={() => setConfirmSwitchToCircle(true)}
                style={{
                  width: '100%',
                  padding: 'clamp(12px, 1.6vw, 14px)',
                  background: 'var(--primary)',
                  color: 'var(--background)',
                  border: 'none',
                  borderRadius: 10,
                  fontSize: 'clamp(12px, 1vw, 13px)',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Switch to Circle-Managed
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 'clamp(11px, 1vw, 12px)', color: 'var(--danger)', margin: 0 }}>
                  A brand-new wallet will be created. Any pending signature requests will be left unresolved. Confirm?
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={switchToCircle}
                    disabled={switching}
                    style={{
                      flex: 1,
                      minWidth: 140,
                      padding: 'clamp(10px, 1.3vw, 13px)',
                      background: switching ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
                      color: switching ? 'rgba(14,11,8,0.5)' : 'var(--background)',
                      border: 'none',
                      borderRadius: 10,
                      fontSize: 'clamp(12px, 1vw, 13px)',
                      fontWeight: 700,
                      cursor: switching ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {switching ? 'Creating...' : 'Yes, Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmSwitchToCircle(false)}
                    style={{
                      flex: 1,
                      minWidth: 100,
                      padding: 'clamp(10px, 1.3vw, 13px)',
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      fontSize: 'clamp(12px, 1vw, 13px)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
