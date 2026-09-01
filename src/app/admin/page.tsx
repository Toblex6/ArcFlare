'use client';

// src/app/admin/page.tsx
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface AdminStats {
    totals: {
        totalVolume: number;
        totalTransactions: number;
        successRate: number;
        totalMerchants: number;
        totalConsumers: number;
        totalWalletsCreated: number;
        totalAgents: number;
        totalEscrows: number;
        totalJobs: number;
    };
    walletBreakdown: {
        merchantCircle: number;
        merchantExternal: number;
        consumerCircle: number;
        consumerExternal: number;
    };
    newMerchantsPerDay: { date: string; count: number }[];
    newConsumersPerDay: { date: string; count: number }[];
    volumePerDay: { date: string; volume: number }[];
}

export default function AdminDashboard() {
    const router = useRouter();
    const [stats, setStats] = useState<AdminStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchStats = async () => {
        try {
            const res = await fetch('/api/admin/stats');
            if (res.status === 401) {
                router.replace('/admin/login');
                return;
            }
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setStats(data.data);
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Could not load stats.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStats();
        const interval = setInterval(fetchStats, 30000);
        return () => clearInterval(interval);
    }, []);

    const signOut = async () => {
        await fetch('/api/admin/login', { method: 'DELETE' });
        router.replace('/admin/login');
    };

    if (loading) {
        return (
            <div style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: '#c8975a', fontFamily: 'monospace' }}>Loading...</p>
            </div>
        );
    }

    if (!stats) return null;

    const chartData = stats.volumePerDay.map((v, i) => ({
        date: v.date.slice(5),
        volume: v.volume,
        merchants: stats.newMerchantsPerDay[i]?.count || 0,
        consumers: stats.newConsumersPerDay[i]?.count || 0,
    }));

    return (
        <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>
            <div style={{ maxWidth: 1100, margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
                    <div>
                        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>Platform Overview</h1>
                        <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>Across every merchant and consumer — last 30 days</p>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Link href="/admin/jobs" style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 8, padding: '8px 16px', color: '#9ca3af', fontSize: 12, textDecoration: 'none' }}>
                            Job Moderation
                        </Link>
                        <Link href="/admin/disputes" style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 8, padding: '8px 16px', color: '#9ca3af', fontSize: 12, textDecoration: 'none' }}>
                            Disputes
                        </Link>
                        <button onClick={signOut} style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 8, padding: '8px 16px', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}>
                            Sign out
                        </button>
                    </div>
                </div>

                {error && (
                    <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: 14, marginBottom: 20 }}>
                        <p style={{ color: '#f87171', fontSize: 13, margin: 0 }}>❌ {error}</p>
                    </div>
                )}

                {/* Top-line stat cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 24 }}>
                    {[
                        { label: 'Total Volume', value: `${stats.totals.totalVolume.toLocaleString()} USDC` },
                        { label: 'Transactions', value: stats.totals.totalTransactions.toLocaleString() },
                        { label: 'Success Rate', value: `${stats.totals.successRate}%` },
                        { label: 'Merchants', value: stats.totals.totalMerchants.toLocaleString() },
                        { label: 'Consumers', value: stats.totals.totalConsumers.toLocaleString() },
                        { label: 'Wallets Created', value: stats.totals.totalWalletsCreated.toLocaleString() },
                        { label: 'Agents Deployed', value: stats.totals.totalAgents.toLocaleString() },
                        { label: 'Escrows', value: stats.totals.totalEscrows.toLocaleString() },
                    ].map((card) => (
                        <div key={card.label} style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 14, padding: 16 }}>
                            <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>{card.label}</p>
                            <p style={{ fontSize: 20, fontWeight: 800, color: '#c8975a', fontFamily: 'monospace', margin: 0 }}>{card.value}</p>
                        </div>
                    ))}
                </div>

                {/* Volume chart */}
                <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 20, marginBottom: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 16px' }}>Volume — last 30 days</h3>
                    <div style={{ height: 200 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={chartData}>
                                <defs>
                                    <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#c8975a" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="#c8975a" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#2d2015" vertical={false} />
                                <XAxis dataKey="date" tick={{ fill: '#6b5a45', fontSize: 10 }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: '#6b5a45', fontSize: 10 }} axisLine={false} tickLine={false} />
                                <Tooltip contentStyle={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 8, fontSize: 12 }} />
                                <Area type="monotone" dataKey="volume" stroke="#c8975a" strokeWidth={2} fill="url(#volGrad)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Signups chart */}
                <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 20, marginBottom: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 16px' }}>New signups — last 30 days</h3>
                    <div style={{ height: 200 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#2d2015" vertical={false} />
                                <XAxis dataKey="date" tick={{ fill: '#6b5a45', fontSize: 10 }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: '#6b5a45', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                                <Tooltip contentStyle={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 8, fontSize: 12 }} />
                                <Bar dataKey="merchants" fill="#c8975a" name="Merchants" radius={[3, 3, 0, 0]} />
                                <Bar dataKey="consumers" fill="#06b6d4" name="Consumers" radius={[3, 3, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Wallet breakdown */}
                <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 16px' }}>Wallet breakdown</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
                        {[
                            { label: 'Merchant — Circle', value: stats.walletBreakdown.merchantCircle },
                            { label: 'Merchant — External', value: stats.walletBreakdown.merchantExternal },
                            { label: 'Consumer — Circle', value: stats.walletBreakdown.consumerCircle },
                            { label: 'Consumer — External', value: stats.walletBreakdown.consumerExternal },
                        ].map((w) => (
                            <div key={w.label} style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 12, padding: 14 }}>
                                <p style={{ fontSize: 10, color: '#6b5a45', margin: '0 0 4px' }}>{w.label}</p>
                                <p style={{ fontSize: 18, fontWeight: 700, color: '#f0ece6', fontFamily: 'monospace', margin: 0 }}>{w.value}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </main>
    );
}
