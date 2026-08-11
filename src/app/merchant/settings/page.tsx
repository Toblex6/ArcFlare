// src/app/merchant/settings/page.tsx
//
// Tabbed Settings area: General, Wallet & Payouts, Notifications,
// API & Webhooks, Security (placeholder). Uses the shared DashboardSidebar
// like every other authenticated page.
//
// Wallet tab rebuilt on the real walletProvider field + SIWE connect flow
// (WalletConnectPanel) + pending signature queue (PendingSignaturesPanel) —
// a previous edit regressed this back to the old walletType/raw-address
// flow the SIWE redesign replaced. Fixed here.

'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import DashboardSidebar from '@/components/DashboardSidebar';
import NotificationSettings from '@/components/NotificationSettings';
import WalletConnectPanel from '@/components/WalletConnectPanel';
import PendingSignaturesPanel from '@/components/PendingSignaturesPanel';

type TabKey = 'general' | 'wallet' | 'notifications' | 'api' | 'security';

interface WalletInfo {
  walletProvider: string;
  walletAddress: string | null;
}

interface MerchantInfo {
  businessName: string;
  email: string;
  apiKeyHint: string;
}

const EXTERNAL_KINDS = new Set(['METAMASK', 'WALLETCONNECT', 'COINBASE']);
const WALLET_LABELS: Record<string, string> = {
  CIRCLE: 'Circle-Managed Wallet',
  METAMASK: 'MetaMask',
  WALLETCONNECT: 'WalletConnect',
  COINBASE: 'Coinbase Wallet',
};

const TABS: { key: TabKey; label: string; icon: string; comingSoon?: boolean }[] = [
  { key: 'general', label: 'General', icon: '⚙️' },
  { key: 'wallet', label: 'Wallet & Payouts', icon: '💳' },
  { key: 'notifications', label: 'Notifications', icon: '🔔' },
  { key: 'api', label: 'API & Webhooks', icon: '🔑' },
  { key: 'security', label: 'Security', icon: '🛡️', comingSoon: true },
];

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: 'clamp(16px, 3vw, 24px)',
};

// ── General tab ────────────────────────────────────────────────────────
function GeneralTab({ merchant }: { merchant: MerchantInfo | null }) {
  if (!merchant) return null;
  return (
    <div style={cardStyle}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>Business Info</h3>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 20px' }}>
        Editing business details isn't wired up yet — reach out if you need this changed for now.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Business Name</p>
          <p style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, margin: 0 }}>{merchant.businessName}</p>
        </div>
        <div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Email</p>
          <p style={{ fontSize: 14, color: 'var(--text)', margin: 0 }}>{merchant.email}</p>
        </div>
      </div>
    </div>
  );
}

// ── Wallet & Payouts tab ───────────────────────────────────────────────
function WalletTab() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(true);
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
    refetchWallet();
    setLoading(false);
  }, []);

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

  if (loading || !wallet) {
    return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading wallet settings...</p>;
  }

  const isExternal = EXTERNAL_KINDS.has(wallet.walletProvider);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: '12px 16px' }}>
          <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0, wordBreak: 'break-word' }}>❌ {error}</p>
        </div>
      )}
      {success && (
        <div style={{ background: 'rgba(13,124,95,0.08)', border: '1px solid rgba(13,124,95,0.2)', borderRadius: 10, padding: '12px 16px' }}>
          <p style={{ color: 'var(--success)', fontSize: 13, margin: 0, wordBreak: 'break-word' }}>✓ {success}</p>
        </div>
      )}

      <div style={cardStyle}>
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 6px' }}>
          Current Payout Method
        </p>
        <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>
          {WALLET_LABELS[wallet.walletProvider] || wallet.walletProvider}
        </p>
        {wallet.walletAddress && (
          <p style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--text)', background: 'var(--surface-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', wordBreak: 'break-all', margin: 0 }}>
            {wallet.walletAddress}
          </p>
        )}
      </div>

      {/* Connect / switch external wallet — real SIWE flow, not a raw address field */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>
          {isExternal ? 'Reconnect or Switch Wallet' : 'Connect Your Own Wallet'}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
          {isExternal
            ? 'Your payouts settle directly to your connected wallet. Connect a different one below to switch.'
            : "Payments settle directly to an address you control — no withdrawal step needed. You'll sign a message to prove you own it; we never see your private key. Your existing Circle wallet balance is NOT auto-transferred — withdraw it first if it holds funds."}
        </p>
        <WalletConnectPanel onConnected={refetchWallet} />
      </div>

      {/* Pending signatures — only relevant on an external wallet */}
      {isExternal && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>Pending Approvals</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
            Some actions (payroll, escrow, streams) need your wallet's signature since you're not on a Circle-managed wallet. Approve them here.
          </p>
          <PendingSignaturesPanel />
        </div>
      )}

      {/* Switch back to Circle */}
      {isExternal && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>Switch to a Managed Wallet</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
            We'll create a new Circle-managed wallet for you. Actions complete instantly again — no more signing required.
          </p>
          {!confirmSwitchToCircle ? (
            <button
              onClick={() => setConfirmSwitchToCircle(true)}
              style={{ padding: '10px 20px', background: 'var(--primary)', color: 'var(--background)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            >
              Switch to Circle-Managed
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0, flex: 1 }}>
                A brand-new wallet will be created. Any pending signature requests will be left unresolved. Confirm?
              </p>
              <button
                onClick={switchToCircle}
                disabled={switching}
                style={{ padding: '10px 20px', background: switching ? 'rgba(200,151,90,0.3)' : 'var(--primary)', color: switching ? 'rgba(14,11,8,0.5)' : 'var(--background)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: switching ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
              >
                {switching ? 'Creating...' : 'Yes, Confirm'}
              </button>
              <button
                onClick={() => setConfirmSwitchToCircle(false)}
                style={{ padding: '10px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── API & Webhooks tab ─────────────────────────────────────────────────
function ApiTab({ merchant }: { merchant: MerchantInfo | null }) {
  if (!merchant) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={cardStyle}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>Your API Key</h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>Key hint shown below — the full key was only shown once, at signup.</p>
        <p style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--text)', background: 'var(--surface-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', margin: 0, wordBreak: 'break-all' }}>
          {merchant.apiKeyHint}
        </p>
      </div>
      <div style={cardStyle}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>Event Webhooks</h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
          Your webhook endpoint for payment/escrow event notifications is configured under the{' '}
          <strong>Notifications</strong> tab, alongside which events get sent to it.
        </p>
      </div>
      <a
        href="/docs/api"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', fontSize: 13, background: 'var(--primary)', color: 'var(--background)', border: 'none', borderRadius: 10, fontWeight: 600, textDecoration: 'none', width: 'fit-content' }}
      >
        📖 View API Docs →
      </a>
    </div>
  );
}

// ── Security tab (placeholder) ─────────────────────────────────────────
function SecurityTab() {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: 48 }}>
      <p style={{ fontSize: 32, margin: '0 0 12px' }}>🛡️</p>
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>Coming soon</p>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>2FA, session management, and login activity will live here.</p>
    </div>
  );
}

export default function MerchantSettings() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [merchant, setMerchant] = useState<MerchantInfo | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  useEffect(() => {
    fetch('/api/merchant/me')
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) {
          router.replace('/merchant/login');
          return;
        }
        setMerchant({
          businessName: data.merchant.businessName,
          email: data.merchant.email,
          apiKeyHint: data.merchant.apiKeyHint,
        });
      })
      .catch(() => router.replace('/merchant/login'))
      .finally(() => setCheckingAuth(false));
  }, [router]);

  if (checkingAuth) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--background)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--primary)', fontFamily: 'monospace', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase' }}>
          Loading settings...
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--background)', color: 'var(--text)', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <DashboardSidebar active="Settings" />

      <main style={{ flex: 1, padding: 'clamp(16px, 4vw, 32px)', overflowX: 'hidden' }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>Settings</h1>
          <p style={{ fontSize: 'clamp(12px, 1vw, 13px)', color: 'var(--text-secondary)', margin: 0 }}>Manage your account, payouts, and notification preferences.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 28, alignItems: 'start' }} className="settings-grid">
          <style>{`
            @media (max-width: 800px) {
              .settings-grid { grid-template-columns: 1fr !important; }
              .settings-nav { flex-direction: row !important; overflow-x: auto; }
            }
          `}</style>

          {/* Secondary settings nav */}
          <nav className="settings-nav" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => !tab.comingSoon && setActiveTab(tab.key)}
                disabled={tab.comingSoon}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: activeTab === tab.key ? 'rgba(200,151,90,0.1)' : 'transparent',
                  color: activeTab === tab.key ? 'var(--primary)' : tab.comingSoon ? 'var(--text-secondary)' : 'var(--text)',
                  opacity: tab.comingSoon ? 0.5 : 1,
                  fontSize: 13,
                  fontWeight: activeTab === tab.key ? 700 : 500,
                  cursor: tab.comingSoon ? 'not-allowed' : 'pointer',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{tab.icon}</span>
                {tab.label}
                {tab.comingSoon && <span style={{ fontSize: 9, marginLeft: 'auto', color: 'var(--text-secondary)' }}>SOON</span>}
              </button>
            ))}
          </nav>

          {/* Active tab content */}
          <div>
            {activeTab === 'general' && <GeneralTab merchant={merchant} />}
            {activeTab === 'wallet' && <WalletTab />}
            {activeTab === 'notifications' && <NotificationSettings />}
            {activeTab === 'api' && <ApiTab merchant={merchant} />}
            {activeTab === 'security' && <SecurityTab />}
          </div>
        </div>
      </main>
    </div>
  );
}
