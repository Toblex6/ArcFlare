// src/app/admin/jobs/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AppDialog from '@/components/AppDialog';

interface AdminJobRow {
    id: string;
    jobId: string;
    clientSCA: string;
    providerSCA: string;
    evaluatorSCA: string;
    description: string;
    budget: string;
    status: string;
    merchantId: string | null;
    createdAt: string;
    removed: boolean;
    removedReason?: string | null;
}

interface AdminPostingRow {
    id: string;
    seq: number;
    humanId: string;
    clientSCA: string;
    title: string | null;
    description: string;
    budgetMax: string;
    status: string;
    merchantId: string | null;
    createdAt: string;
}

export default function AdminJobsPage() {
    const router = useRouter();
    const [jobs, setJobs] = useState<AdminJobRow[]>([]);
    const [postings, setPostings] = useState<AdminPostingRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);
    // Reason-entry dialog (replaced the two browser prompt calls). One dialog
    // serves both jobs and postings; the target disambiguates the endpoint.
    const [removeTarget, setRemoveTarget] = useState<{ kind: 'job' | 'posting'; id: string } | null>(null);
    const [reasonInput, setReasonInput] = useState('malicious or bad content');
    const reasonInputRef = React.useRef<HTMLInputElement>(null);

    const openRemoveJob = (jobId: string) => {
        setReasonInput('malicious or bad content');
        setRemoveTarget({ kind: 'job', id: jobId });
    };

    const openRemovePosting = (id: string) => {
        setReasonInput('malicious or bad content');
        setRemoveTarget({ kind: 'posting', id });
    };

    const fetchJobs = async () => {
        try {
            const res = await fetch('/api/admin/jobs');
            if (res.status === 401) {
                router.replace('/admin/login');
                return;
            }
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setJobs(data.jobs);
            setPostings(data.postings);
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Could not load jobs.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchJobs();
        const interval = setInterval(fetchJobs, 20000);
        return () => clearInterval(interval);
    }, []);

    const confirmRemove = async () => {
        if (!removeTarget || removing) return;
        const { kind, id } = removeTarget;
        // Preserve the prompt's value semantics: an empty/cleared reason still
        // submits the 'removed by admin' fallback the old code used.
        const reason = reasonInput || 'removed by admin';
        setRemoveTarget(null);
        setReasonInput('malicious or bad content');
        setRemoving(kind === 'job' ? `job:${id}` : `posting:${id}`);
        try {
            const url = kind === 'job'
                ? `/api/admin/jobs/${id}/remove`
                : `/api/admin/postings/${id}/remove`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            await fetchJobs();
        } catch (e: any) {
            setError(e.message || 'Remove failed.');
        } finally {
            setRemoving(null);
        }
    };

    if (loading) {
        return (
            <div style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: '#c8975a', fontFamily: 'monospace' }}>Loading jobs...</p>
            </div>
        );
    }

    const Row = ({ children, removed }: { children: React.ReactNode; removed?: boolean }) => (
        <div
            style={{
                background: '#1a1410',
                border: removed ? '1px solid rgba(239,68,68,0.3)' : '1px solid #2d2015',
                borderRadius: 14,
                padding: 16,
                opacity: removed ? 0.6 : 1,
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>{children}</div>
        </div>
    );

    const statusColor = (s: string) =>
        s === 'COMPLETED' || s === 'RELEASED' ? '#34d399' :
        s === 'REJECTED' || s === 'CANCELLED' ? '#f87171' :
        s === 'FUNDED' ? '#06b6d4' :
        s === 'OPEN' ? '#f59e0b' : '#6b5a45';

    return (
        <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
            <div style={{ maxWidth: 1100, margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div>
                        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>Job Moderation</h1>
                        <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>
                            {jobs.length} ERC-8183 jobs · {postings.length} procurement postings — remove malicious/bad ones
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

                {/* Procurement postings */}
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: '28px 0 12px', color: '#f0ece6' }}>Procurement Postings (apply on Telegram)</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {postings.length === 0 ? (
                        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 32, textAlign: 'center' }}>
                            <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>No procurement postings.</p>
                        </div>
                    ) : (
                        postings.map((p) => (
                            <Row key={p.id} removed={p.status === 'CANCELLED' || p.status === 'CLOSED'}>
                                <div style={{ minWidth: 0 }}>
                                    <p style={{ fontFamily: 'monospace', fontSize: 13, color: '#c8975a', margin: '0 0 4px' }}>
                                        {p.humanId} <span style={{ color: '#4b4035', fontSize: 11 }}>({p.id})</span>
                                    </p>
                                    <p style={{ fontSize: 13, color: '#f0ece6', margin: '0 0 4px' }}>{p.title || p.description?.slice(0, 80) || 'Untitled'}</p>
                                    <p style={{ fontSize: 11, color: '#6b5a45', margin: 0, fontFamily: 'monospace' }}>
                                        client {p.clientSCA.slice(0, 12)}... · budget up to {(() => { try { return (Number(p.budgetMax) / 1e6).toFixed(2); } catch { return '?'; } })()} USDC
                                    </p>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                                    <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 20, background: 'rgba(245,158,11,0.1)', color: statusColor(p.status), border: '1px solid rgba(245,158,11,0.25)', fontWeight: 700 }}>
                                        {p.status}
                                    </span>
                                    <span style={{ fontSize: 10, color: '#4b4035' }}>{new Date(p.createdAt).toLocaleDateString()}</span>
                                    {p.status !== 'CANCELLED' && p.status !== 'CLOSED' && (
                                        <button
                                            onClick={() => openRemovePosting(p.id)}
                                            disabled={removing === `posting:${p.id}`}
                                            style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, padding: '6px 12px', color: '#f87171', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                        >
                                            {removing === `posting:${p.id}` ? 'Removing...' : 'Remove'}
                                        </button>
                                    )}
                                </div>
                            </Row>
                        ))
                    )}
                </div>

                {/* ERC-8183 jobs */}
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: '28px 0 12px', color: '#f0ece6' }}>ERC-8183 Jobs (on-chain)</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {jobs.length === 0 ? (
                        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 32, textAlign: 'center' }}>
                            <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>No jobs.</p>
                        </div>
                    ) : (
                        jobs.map((j) => (
                            <Row key={j.id} removed={j.removed}>
                                <div style={{ minWidth: 0 }}>
                                    <p style={{ fontFamily: 'monospace', fontSize: 13, color: '#c8975a', margin: '0 0 4px' }}>
                                        #{j.jobId} {j.removed && <span style={{ color: '#f87171' }}>· REMOVED</span>}
                                    </p>
                                    <p style={{ fontSize: 13, color: '#f0ece6', margin: '0 0 4px' }}>{j.description?.slice(0, 80)}</p>
                                    <p style={{ fontSize: 11, color: '#6b5a45', margin: 0, fontFamily: 'monospace' }}>
                                        client {j.clientSCA.slice(0, 12)}... · provider {j.providerSCA.slice(0, 12)}... · {(() => { try { return (Number(j.budget) / 1e6).toFixed(4); } catch { return '?'; } })()} USDC
                                    </p>
                                    {j.removed && j.removedReason && (
                                        <p style={{ fontSize: 11, color: '#f87171', margin: '4px 0 0' }}>reason: {j.removedReason}</p>
                                    )}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                                    <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 20, background: 'rgba(245,158,11,0.1)', color: statusColor(j.status), border: '1px solid rgba(245,158,11,0.25)', fontWeight: 700 }}>
                                        {j.status}
                                    </span>
                                    <span style={{ fontSize: 10, color: '#4b4035' }}>{new Date(j.createdAt).toLocaleDateString()}</span>
                                    {!j.removed && (
                                        <button
                                            onClick={() => openRemoveJob(j.jobId)}
                                            disabled={removing === `job:${j.jobId}`}
                                            style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, padding: '6px 12px', color: '#f87171', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                        >
                                            {removing === `job:${j.jobId}` ? 'Removing...' : 'Remove'}
                                        </button>
                                    )}
                                </div>
                            </Row>
                        ))
                    )}
                </div>
            </div>

            <AppDialog
                open={!!removeTarget}
                title={removeTarget?.kind === 'job' ? 'Remove this job?' : 'Remove this posting?'}
                description="This hides it from users. The reason is recorded for moderation audit."
                onClose={() => setRemoveTarget(null)}
                maxWidth={400}
                initialFocusRef={reasonInputRef}
            >
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        confirmRemove();
                    }}
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b5a45' }} htmlFor="remove-reason">
                        Reason
                    </label>
                    <input
                        id="remove-reason"
                        ref={reasonInputRef}
                        value={reasonInput}
                        onChange={(e) => setReasonInput(e.target.value)}
                        placeholder="malicious or bad content"
                        style={{
                            width: '100%',
                            padding: '10px 14px',
                            background: '#1a1410',
                            border: '1px solid #2d2015',
                            borderRadius: 10,
                            color: '#f0ece6',
                            fontSize: 13,
                            outline: 'none',
                            boxSizing: 'border-box',
                        }}
                    />
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                        <button
                            type="button"
                            onClick={() => setRemoveTarget(null)}
                            style={{ background: 'transparent', border: '1px solid #2d2015', borderRadius: 8, padding: '8px 16px', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={!!removing}
                            style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, padding: '8px 16px', color: '#f87171', fontSize: 12, fontWeight: 700, cursor: removing ? 'not-allowed' : 'pointer' }}
                        >
                            {removing ? 'Removing...' : 'Confirm remove'}
                        </button>
                    </div>
                </form>
            </AppDialog>
        </main>
    );
}
