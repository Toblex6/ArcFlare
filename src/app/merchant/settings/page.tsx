// src/app/merchant/settings/page.tsx
//
// Redesigned from a standalone "Payout Settings" page into a full Settings
// area with tabs: General, Wallet & Payouts, Notifications, API & Webhooks,
// Security (placeholder). Now uses the shared DashboardSidebar like every
// other authenticated page, instead of its own standalone centered layout —
// previously this was the only page not using it.
//
// NotificationSettings.tsx was built earlier but had no page mounting it —
// it's now live under the Notifications tab.

'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import DashboardSidebar from '@/src/components/DashboardSidebar';
import NotificationSettings from '@/src/components/NotificationSettings';

type TabKey = 'general' | 'wallet' | 'notifications' | 'api' | 'security';

interface WalletInfo {
    walletType: 'CIRCLE' | 'EXTERNAL';
    walletAddress: string | null;
}

interface MerchantInfo {
    businessName: string;
    email: string;
    apiKeyHint: string;
}

const TABS: { key: TabKey; label: string; icon: string; comingSoon?: boolean }[] = [
    { key: 'general', label: 'General', icon: '⚙️' },
    { key: 'wallet', label: 'Wallet & Payouts', icon: '💳' },
    { key: 'notifications', label: 'Notifications', icon: '🔔' },
    { key: 'api', label: 'API & Webhooks', icon: '🔑' },
    { key: 'security', label: 'Security', icon: '🛡️', comingSoon: true },
];

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 16,
    padding: 24,
};

// ── General tab ────────────────────────────────────────────────────────
function GeneralTab({ merchant }: { merchant: MerchantInfo | null }) {
    if (!merchant) return null;
    return (
        <div style={cardStyle}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Business Info</h3>
            <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 20px' }}>
                Editing business details isn't wired up yet — reach out if you need this changed for now.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                    <p style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Business Name</p>
                    <p style={{ fontSize: 14, color: '#0f172a', fontWeight: 600, margin: 0 }}>{merchant.businessName}</p>
                </div>
                <div>
                    <p style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Email</p>
                    <p style={{ fontSize: 14, color: '#0f172a', margin: 0 }}>{merchant.email}</p>
                </div>
            </div>
        </div>
    );
}

// ── Wallet & Payouts tab (existing logic, unchanged) ──────────────────
function WalletTab() {
    const [wallet, setWallet] = useState<WalletInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [switching, setSwitching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [externalAddress, setExternalAddress] = useState('');
    const [confirmSwitchToCircle, setConfirmSwitchToCircle] = useState(false);

    useEffect(() => {
        fetch('/api/merchant/wallet')
            .then((r) => r.json())
            .then((data) => {
                if (data.success) setWallet(data.wallet);
            })
            .finally(() => setLoading(false));
    }, []);

    const switchToExternal = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!/^0x[a-fA-F0-9]{40}$/.test(externalAddress)) {
            setError('Enter a valid wallet address (0x...).');
            return;
        }
        setSwitching(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch('/api/merchant/wallet', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletType: 'EXTERNAL', externalAddress }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setWallet(data.wallet);
            setSuccess(data.message);
            setExternalAddress('');
        } catch (err: any) {
            setError(err.message || 'Could not switch wallet.');
        } finally {
            setSwitching(false);
        }
    };

    const switchToCircle = async () => {
        setSwitching(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch('/api/merchant/wallet', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletType: 'CIRCLE' }),
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
        return <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading wallet settings...</p>;
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {error && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px' }}>
                    <p style={{ color: '#dc2626', fontSize: 13, margin: 0 }}>❌ {error}</p>
                </div>
            )}
            {success && (
                <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: '12px 16px' }}>
                    <p style={{ color: '#059669', fontSize: 13, margin: 0 }}>✓ {success}</p>
                </div>
            )}

            <div style={cardStyle}>
                <p style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 6px' }}>
                    Current Payout Method
                </p>
                <p style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>
                    {wallet.walletType === 'CIRCLE' ? 'Circle-Managed Wallet' : 'External Wallet'}
                </p>
                {wallet.walletAddress && (
                    <p style={{ fontFamily: 'monospace', fontSize: 13, color: '#475569', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', wordBreak: 'break-all', margin: 0 }}>
                        {wallet.walletAddress}
                    </p>
                )}
            </div>

            {wallet.walletType === 'CIRCLE' && (
                <div style={cardStyle}>
                    <h3 style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>Switch to Your Own Wallet</h3>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 16px' }}>
                        Payments will settle directly to an address you control — no more withdrawal step needed.
                        Your existing Circle wallet balance is NOT auto-transferred; withdraw it first if it holds funds.
                    </p>
                    <form onSubmit={switchToExternal} style={{ display: 'flex', gap: 10 }}>
                        <input
                            type="text"
                            placeholder="0x..."
                            value={externalAddress}
                            onChange={(e) => setExternalAddress(e.target.value)}
                            style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', fontSize: 13, fontFamily: 'monospace', outline: 'none' }}
                        />
                        <button
                            type="submit"
                            disabled={switching}
                            style={{ padding: '10px 20px', background: switching ? '#94a3b8' : '#0d7c5f', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: switching ? 'not-allowed' : 'pointer' }}
                        >
                            {switching ? 'Switching...' : 'Switch'}
                        </button>
                    </form>
                </div>
            )}

            {wallet.walletType === 'EXTERNAL' && (
                <div style={cardStyle}>
                    <h3 style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>Switch to a Managed Wallet</h3>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 16px' }}>
                        We'll create a new Circle-managed wallet for you. You can withdraw from it to any address anytime.
                    </p>
                    {!confirmSwitchToCircle ? (
                        <button
                            onClick={() => setConfirmSwitchToCircle(true)}
                            style={{ padding: '10px 20px', background: '#0d7c5f', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                        >
                            Switch to Circle-Managed
                        </button>
                    ) : (
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <p style={{ fontSize: 12, color: '#dc2626', margin: 0, flex: 1 }}>
                                A brand-new wallet will be created. Confirm?
                            </p>
                            <button
                                onClick={switchToCircle}
                                disabled={switching}
                                style={{ padding: '10px 20px', background: switching ? '#94a3b8' : '#0d7c5f', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: switching ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
                            >
                                {switching ? 'Creating...' : 'Yes, Confirm'}
                            </button>
                            <button
                                onClick={() => setConfirmSwitchToCircle(false)}
                                style={{ padding: '10px 16px', background: 'transparent', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}
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
                <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Your API Key</h3>
                <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 16px' }}>Key hint shown below — the full key was only shown once, at signup.</p>
                <p style={{ fontSize: 13, fontFamily: 'monospace', color: '#0f172a', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', margin: 0, wordBreak: 'break-all' }}>
                    {merchant.apiKeyHint}
                </p>
            </div>
            <div style={cardStyle}>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Event Webhooks</h3>
                <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                    Your webhook endpoint for payment/escrow event notifications is configured under the{' '}
                    <strong>Notifications</strong> tab, alongside which events get sent to it.
                </p>
            </div>
            <a
                href="/docs/api"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', fontSize: 13, background: '#0d7c5f', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 600, textDecoration: 'none', width: 'fit-content' }}
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
            <p style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>Coming soon</p>
            <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>2FA, session management, and login activity will live here.</p>
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
            <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: '#0d7c5f', fontFamily: 'monospace', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase' }}>
                    Loading settings...
                </p>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <DashboardSidebar active="Settings" />

            <main style={{ flex: 1, padding: 32, overflowX: 'hidden' }}>
                <div style={{ marginBottom: 28 }}>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Settings</h1>
                    <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>Manage your account, payouts, and notification preferences.</p>
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
                                    background: activeTab === tab.key ? 'rgba(13,124,95,0.1)' : 'transparent',
                                    color: activeTab === tab.key ? '#0d7c5f' : tab.comingSoon ? '#cbd5e1' : '#475569',
                                    fontSize: 13,
                                    fontWeight: activeTab === tab.key ? 700 : 500,
                                    cursor: tab.comingSoon ? 'not-allowed' : 'pointer',
                                    textAlign: 'left',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                <span>{tab.icon}</span>
                                {tab.label}
                                {tab.comingSoon && <span style={{ fontSize: 9, marginLeft: 'auto', color: '#cbd5e1' }}>SOON</span>}
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
