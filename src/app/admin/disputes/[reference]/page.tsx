// src/app/admin/disputes/[reference]/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface EscrowDetail {
    reference: string;
    amount: number;
    currency: string;
    depositorSCA: string;
    beneficiarySCA: string;
    status: string;
    condition: string | null;
    disputeReason: string | null;
    disputedBy: string | null;
    disputeTxHash: string | null;
    createdAt: string;
}

interface Evidence {
    id: string;
    submittedBy: string;
    role: string;
    type: string;
    content: string;
    createdAt: string;
}

export default function AdminDisputeDetailPage() {
    const params = useParams<{ reference: string }>();
    const reference = params?.reference;
    const router = useRouter();

    const [escrow, setEscrow] = useState<EscrowDetail | null>(null);
    const [evidence, setEvidence] = useState<Evidence[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [resolving, setResolving] = useState(false);
    const [resolveError, setResolveError] = useState<string | null>(null);
    const [resolveResult, setResolveResult] = useState<any>(null);
    const [confirmAction, setConfirmAction] = useState<'beneficiary' | 'depositor' | null>(null);

    const fetchDetail = async () => {
        try {
            const res = await fetch(`/api/admin/disputes/${reference}`);
            if (res.status === 401) {
                router.replace('/admin/login');
                return;
            }
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setEscrow(data.escrow);
            setEvidence(data.evidence);
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Could not load dispute.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (reference) fetchDetail();
    }, [reference]);

    const handleResolve = async (releaseToBeneficiary: boolean) => {
        setResolving(true);
        setResolveError(null);
        try {
            const res = await fetch(`/api/admin/disputes/${reference}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ releaseToBeneficiary }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setResolveResult(data);
            setConfirmAction(null);
            await fetchDetail();
        } catch (e: any) {
            setResolveError(e.message || 'Could not resolve dispute.');
        } finally {
            setResolving(false);
        }
    };

    if (loading) {
        return (
            <div style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: '#c8975a', fontFamily: 'monospace' }}>Loading dispute...</p>
            </div>
        );
    }

    if (error || !escrow) {
        return (
            <div style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <p style={{ color: '#f87171', fontSize: 14 }}>❌ {error || 'Dispute not found.'}</p>
            </div>
        );
    }

    const alreadyResolved = escrow.status !== 'DISPUTED';

    return (
        <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
            <div style={{ maxWidth: 900, margin: '0 auto' }}>
                <Link href="/admin/disputes" style={{ color: '#6b5a45', fontSize: 12, textDecoration: 'none' }}>
                    ← All Disputes
                </Link>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 12, marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
                    <div>
                        <p style={{ fontFamily: 'monospace', fontSize: 12, color: '#c8975a', margin: '0 0 6px' }}>{escrow.reference}</p>
                        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{escrow.amount.toFixed(2)} {escrow.currency} in dispute</h1>
                    </div>
                    <span
                        style={{
                            fontSize: 11,
                            padding: '4px 12px',
                            borderRadius: 20,
                            fontWeight: 700,
                            background: alreadyResolved ? 'rgba(107,114,128,0.12)' : 'rgba(245,158,11,0.12)',
                            color: alreadyResolved ? '#9ca3af' : '#f59e0b',
                            border: `1px solid ${alreadyResolved ? 'rgba(107,114,128,0.3)' : 'rgba(245,158,11,0.3)'}`,
                        }}
                    >
                        {escrow.status}
                    </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
                    {/* LEFT: dispute details + evidence */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 20 }}>
                            <h3 style={{ fontSize: 13, fontWeight: 700, color: '#f0ece6', margin: '0 0 12px' }}>Dispute Details</h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#6b5a45' }}>Depositor</span>
                                    <span style={{ fontFamily: 'monospace', color: '#f0ece6' }}>{escrow.depositorSCA}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#6b5a45' }}>Beneficiary</span>
                                    <span style={{ fontFamily: 'monospace', color: '#f0ece6' }}>{escrow.beneficiarySCA}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#6b5a45' }}>Disputed by</span>
                                    <span style={{ fontFamily: 'monospace', color: '#f0ece6' }}>
                                        {escrow.disputedBy}{' '}
                                        ({escrow.disputedBy?.toLowerCase() === escrow.depositorSCA.toLowerCase() ? 'depositor' : 'beneficiary'})
                                    </span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#6b5a45' }}>Original condition</span>
                                    <span style={{ color: '#f0ece6', textAlign: 'right', maxWidth: 260 }}>{escrow.condition || '—'}</span>
                                </div>
                            </div>
                            <div style={{ marginTop: 14, background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 10, padding: 12 }}>
                                <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Dispute Reason</p>
                                <p style={{ fontSize: 13, color: '#f0ece6', margin: 0 }}>{escrow.disputeReason || 'No reason provided'}</p>
                            </div>
                        </div>

                        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 20 }}>
                            <h3 style={{ fontSize: 13, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>Submitted Evidence</h3>
                            <p style={{ fontSize: 11, color: '#6b5a45', margin: '0 0 14px' }}>{evidence.length} item{evidence.length === 1 ? '' : 's'}</p>

                            {evidence.length === 0 ? (
                                <p style={{ fontSize: 12, color: '#4b4035', margin: 0 }}>Neither party has submitted additional evidence yet.</p>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    {evidence.map((e) => (
                                        <div key={e.id} style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 10, padding: 12 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 10 }}>
                                                <span style={{ color: '#c8975a', fontWeight: 700, textTransform: 'uppercase' }}>{e.role}</span>
                                                <span style={{ color: '#4b4035' }}>{new Date(e.createdAt).toLocaleString()}</span>
                                            </div>
                                            {e.type === 'link' ? (
                                                <a href={e.content} target="_blank" rel="noopener noreferrer" style={{ color: '#06b6d4', fontSize: 12, wordBreak: 'break-all' }}>
                                                    {e.content}
                                                </a>
                                            ) : (
                                                <p style={{ fontSize: 12, color: '#f0ece6', margin: 0, whiteSpace: 'pre-wrap' }}>{e.content}</p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Explicit placeholder — AI evidence analysis plugs in here later, not built yet */}
                        <div style={{ background: '#1a1410', border: '1px dashed #3d2e1a', borderRadius: 16, padding: 20, opacity: 0.6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span style={{ fontSize: 16 }}>🤖</span>
                                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#f0ece6', margin: 0 }}>AI Evidence Analysis</h3>
                                <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 10, background: 'rgba(107,114,128,0.15)', color: '#9ca3af' }}>PLANNED</span>
                            </div>
                            <p style={{ fontSize: 12, color: '#6b5a45', margin: 0 }}>
                                A future automated analysis of the evidence above will surface here as a recommendation —
                                not a decision. The admin resolve actions below will remain the final authority regardless.
                            </p>
                        </div>
                    </div>

                    {/* RIGHT: resolve actions */}
                    <div>
                        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 20, position: 'sticky', top: 24 }}>
                            <h3 style={{ fontSize: 13, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>Resolve Dispute</h3>
                            <p style={{ fontSize: 11, color: '#6b5a45', margin: '0 0 18px' }}>
                                This calls the contract directly — irreversible once confirmed onchain.
                            </p>

                            {alreadyResolved ? (
                                <div style={{ background: 'rgba(13,124,95,0.08)', border: '1px solid rgba(13,124,95,0.2)', borderRadius: 10, padding: 14, textAlign: 'center' }}>
                                    <p style={{ fontSize: 12, color: '#0d7c5f', margin: 0 }}>
                                        ✓ Already resolved — status: {escrow.status}
                                    </p>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    {confirmAction === null ? (
                                        <>
                                            <button
                                                onClick={() => setConfirmAction('beneficiary')}
                                                disabled={resolving}
                                                style={{ padding: 14, borderRadius: 10, border: 'none', background: '#0d7c5f', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                            >
                                                Release to Beneficiary
                                            </button>
                                            <button
                                                onClick={() => setConfirmAction('depositor')}
                                                disabled={resolving}
                                                style={{ padding: 14, borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                            >
                                                Refund to Depositor
                                            </button>
                                        </>
                                    ) : (
                                        <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: 14 }}>
                                            <p style={{ fontSize: 12, color: '#f0ece6', margin: '0 0 12px' }}>
                                                Confirm: {escrow.amount.toFixed(2)} {escrow.currency} goes to{' '}
                                                <strong>{confirmAction === 'beneficiary' ? 'the beneficiary' : 'the depositor'}</strong>. This is final.
                                            </p>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <button
                                                    onClick={() => handleResolve(confirmAction === 'beneficiary')}
                                                    disabled={resolving}
                                                    style={{ flex: 1, padding: 12, borderRadius: 8, border: 'none', background: resolving ? '#6b5a45' : '#dc2626', color: '#fff', fontSize: 12, fontWeight: 700, cursor: resolving ? 'not-allowed' : 'pointer' }}
                                                >
                                                    {resolving ? 'Confirming onchain...' : 'Yes, Resolve'}
                                                </button>
                                                <button
                                                    onClick={() => setConfirmAction(null)}
                                                    disabled={resolving}
                                                    style={{ padding: '12px 16px', borderRadius: 8, border: '1px solid #3d2e1a', background: 'transparent', color: '#6b5a45', fontSize: 12, cursor: 'pointer' }}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {resolveError && (
                                <p style={{ color: '#f87171', fontSize: 12, marginTop: 12 }}>❌ {resolveError}</p>
                            )}

                            {resolveResult && (
                                <div style={{ marginTop: 14, background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 10, padding: 14 }}>
                                    <p style={{ fontSize: 12, color: '#06b6d4', fontWeight: 700, margin: '0 0 6px' }}>✓ {resolveResult.message}</p>
                                    <a href={resolveResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#6b5a45', fontFamily: 'monospace' }}>
                                        View transaction ↗
                                    </a>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
