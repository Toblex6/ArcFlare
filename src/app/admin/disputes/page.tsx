// src/app/admin/disputes/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface DisputeRow {
    reference: string;
    amount: number;
    currency: string;
    depositorSCA: string;
    beneficiarySCA: string;
    disputeReason: string | null;
    disputedBy: string | null;
    createdAt: string;
    evidenceCount: number;
}

export default function AdminDisputesPage() {
    const router = useRouter();
    const [disputes, setDisputes] = useState<DisputeRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchDisputes = async () => {
        try {
            const res = await fetch('/api/admin/disputes');
            if (res.status === 401) {
                router.replace('/admin/login');
                return;
            }
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setDisputes(data.disputes);
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Could not load disputes.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchDisputes();
        const interval = setInterval(fetchDisputes, 15000);
        return () => clearInterval(interval);
    }, []);

    if (loading) {
        return (
            <div style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: '#c8975a', fontFamily: 'monospace' }}>Loading disputes...</p>
            </div>
        );
    }

    return (
        <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
            <div style={{ maxWidth: 1100, margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div>
                        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>Dispute Resolution</h1>
                        <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>
                            {disputes.length} open dispute{disputes.length === 1 ? '' : 's'} awaiting review
                        </p>
                    </div>
                    <Link href="/admin" style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 8, padding: '8px 16px', color: '#9ca3af', fontSize: 12, textDecoration: 'none' }}>
                        ← Platform Overview
                    </Link>
                </div>

                {error && (
                    <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: 14, marginTop: 20 }}>
                        <p style={{ color: '#f87171', fontSize: 13, margin: 0 }}>❌ {error}</p>
                    </div>
                )}

                <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {disputes.length === 0 ? (
                        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 48, textAlign: 'center' }}>
                            <p style={{ fontSize: 32, margin: '0 0 12px' }}>✓</p>
                            <p style={{ color: '#6b5a45', fontSize: 14, margin: 0 }}>No open disputes right now.</p>
                        </div>
                    ) : (
                        disputes.map((d) => (
                            <Link
                                key={d.reference}
                                href={`/admin/disputes/${d.reference}`}
                                style={{
                                    display: 'block',
                                    background: '#1a1410',
                                    border: '1px solid #2d2015',
                                    borderRadius: 16,
                                    padding: 20,
                                    textDecoration: 'none',
                                    color: 'inherit',
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                                    <div>
                                        <p style={{ fontFamily: 'monospace', fontSize: 13, color: '#c8975a', margin: '0 0 6px' }}>{d.reference}</p>
                                        <p style={{ fontSize: 13, color: '#f0ece6', margin: '0 0 4px' }}>
                                            {d.amount.toFixed(2)} {d.currency} — disputed by{' '}
                                            <span style={{ fontFamily: 'monospace' }}>{d.disputedBy?.slice(0, 10)}...</span>
                                        </p>
                                        <p style={{ fontSize: 12, color: '#6b5a45', margin: 0, maxWidth: 500 }}>
                                            {d.disputeReason || 'No reason provided'}
                                        </p>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                                        <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 20, background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)', fontWeight: 700 }}>
                                            DISPUTED
                                        </span>
                                        <span style={{ fontSize: 11, color: '#6b5a45' }}>
                                            {d.evidenceCount} evidence item{d.evidenceCount === 1 ? '' : 's'}
                                        </span>
                                        <span style={{ fontSize: 10, color: '#4b4035' }}>
                                            {new Date(d.createdAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>
                            </Link>
                        ))
                    )}
                </div>
            </div>
        </main>
    );
}
