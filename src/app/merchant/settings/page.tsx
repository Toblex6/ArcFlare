// src/app/merchant/settings/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface WalletInfo {
    walletType: 'CIRCLE' | 'EXTERNAL';
    walletAddress: string | null;
}

export default function MerchantSettings() {
    const router = useRouter();
    const [checkingAuth, setCheckingAuth] = useState(true);
    const [wallet, setWallet] = useState<WalletInfo | null>(null);
    const [switching, setSwitching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [externalAddress, setExternalAddress] = useState('');
    const [confirmSwitchToCircle, setConfirmSwitchToCircle] = useState(false);

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

    if (checkingAuth || !wallet) {
        return (
            <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: '#0891b2', fontFamily: 'monospace', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase' }}>
                    Loading settings...
                </p>
            </div>
        );
    }

    return (
        <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'Inter, system-ui, sans-serif', padding: 32 }}>
            <div style={{ maxWidth: 600, margin: '0 auto' }}>
                <button
                    onClick={() => router.push('/merchant/dashboard')}
                    style={{ background: 'none', border: 'none', color: '#0891b2', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 20, padding: 0 }}
                >
                    ← Back to Dashboard
                </button>

                <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Payout Settings</h1>
                <p style={{ color: '#64748b', fontSize: 14, margin: '0 0 28px' }}>
                    Control where your payments settle.
                </p>

                {error && (
                    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
                        <p style={{ color: '#dc2626', fontSize: 13, margin: 0 }}>❌ {error}</p>
                    </div>
                )}
                {success && (
                    <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
                        <p style={{ color: '#059669', fontSize: 13, margin: 0 }}>✓ {success}</p>
                    </div>
                )}

                {/* Current wallet */}
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 24, marginBottom: 20 }}>
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

                {/* Switch to external */}
                {wallet.walletType === 'CIRCLE' && (
                    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 24, marginBottom: 20 }}>
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
                                style={{ padding: '10px 20px', background: switching ? '#94a3b8' : '#0891b2', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: switching ? 'not-allowed' : 'pointer' }}
                            >
                                {switching ? 'Switching...' : 'Switch'}
                            </button>
                        </form>
                    </div>
                )}

                {/* Switch to Circle */}
                {wallet.walletType === 'EXTERNAL' && (
                    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 24 }}>
                        <h3 style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>Switch to a Managed Wallet</h3>
                        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 16px' }}>
                            We'll create a new Circle-managed wallet for you. You can withdraw from it to any address anytime.
                        </p>
                        {!confirmSwitchToCircle ? (
                            <button
                                onClick={() => setConfirmSwitchToCircle(true)}
                                style={{ padding: '10px 20px', background: '#0891b2', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                            >
                                Switch to Circle-Managed
                            </button>
                        ) : (
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <p style={{ fontSize: 12, color: '#dc2626', margin: 0, flex: 1 }}>
                                    A brand-new wallet will be created. Confirm?
                                </p>
                                <button
                                    onClick={switchToCircle}
                                    disabled={switching}
                                    style={{ padding: '10px 20px', background: switching ? '#94a3b8' : '#0891b2', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: switching ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
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
        </div>
    );
}
