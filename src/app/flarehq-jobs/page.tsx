'use client';

// FlareHQ Jobs — FlareHQEscrow-backed job lifecycle. This page deliberately
// never calls the ERC-8183 routes and never labels this product ERC-8183.

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import DashboardSidebar from '@/src/components/DashboardSidebar';
import FlareHQExternalTransactions, { type JobTransactionIntent } from '@/components/jobs/FlareHQExternalTransactions';

type Job = {
  id: string;
  jobNumber: string;
  title?: string | null;
  description: string;
  budgetUSDC: string;
  status: string;
  clientAddress: string;
  providerAddress?: string | null;
  applications?: Array<{ id: string; applicantAddress: string; pitch: string; proposedAmount?: string | null }>;
};

async function readJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.message ?? body.error ?? 'Request failed.');
  return body;
}

export default function FlareHQJobsPage() {
  const { address, isConnected } = useAccount();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('');
  const [pitch, setPitch] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const [reason, setReason] = useState('');
  const [walletAction, setWalletAction] = useState<{ transactions: JobTransactionIntent[]; confirm: { endpoint: string; body?: Record<string, unknown> } } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await readJson(await fetch('/api/flarehq-jobs?status=all', { cache: 'no-store' }));
      setJobs(data.jobs ?? []);
      if (selected) {
        const latest = (data.jobs ?? []).find((j: Job) => j.id === selected.id);
        if (latest) setSelected(latest);
      }
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [selected]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(url: string, body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const data = await readJson(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      if (data.pendingWallet) {
        const transactions = (data.transactions ?? (data.transaction ? [data.transaction] : [])) as JobTransactionIntent[];
        const confirm = data.confirm ?? { endpoint: url, body };
        setWalletAction({ transactions, confirm });
      }
      await load();
      return data;
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function openJob(job: Job) {
    try {
      const data = await readJson(await fetch(`/api/flarehq-jobs/${job.id}`, { cache: 'no-store' }));
      setSelected(data.job);
    } catch (e: any) { setError(e.message); }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', display: 'flex' }}>
      <DashboardSidebar active="Jobs" />
      <section style={{ flex: 1, padding: '42px clamp(20px, 4vw, 64px)', maxWidth: 1200 }}>
        <p style={{ color: '#c8975a', textTransform: 'uppercase', letterSpacing: 2, fontSize: 11 }}>FlareHQ Jobs</p>
        <h1 style={{ fontSize: 34, margin: '0 0 8px' }}>Jobs protected by FlareHQEscrow</h1>
        <p style={{ color: '#a89684', maxWidth: 760, lineHeight: 1.6 }}>
          Post, apply, select, fund, submit, approve, release, dispute, or refund. This is the FlareHQ Jobs product—not ERC-8183. Funding stays unavailable until FlareHQEscrow is configured on this network. Release charges 25 bps to the treasury; FlareHQ never holds the funds.
        </p>

        {error && <div style={{ margin: '18px 0', padding: 14, border: '1px solid rgba(239,68,68,.35)', borderRadius: 12, color: '#f87171' }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.4fr)', gap: 20, alignItems: 'start' }}>
          <div>
            <div style={{ padding: 20, border: '1px solid #3d2e1a', borderRadius: 16, background: '#17110c', marginBottom: 18 }}>
              <h2 style={{ marginTop: 0 }}>Post a FlareHQ Job</h2>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={input} />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the work" style={{ ...input, minHeight: 90 }} />
              <input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Budget in USDC (e.g. 25.00)" style={input} />
              <button disabled={!isConnected || busy} style={button} onClick={async () => {
                const data = await act('/api/flarehq-jobs', { clientAddress: address, title, description, budget });
                if (data?.job) { setTitle(''); setDescription(''); setBudget(''); setSelected(data.job); }
              }}>{isConnected ? 'Post Job' : 'Connect wallet to post'}</button>
            </div>

            <h2>Job board</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {jobs.map((job) => (
                <button key={job.id} onClick={() => openJob(job)} style={{ ...card, textAlign: 'left', cursor: 'pointer', color: '#f0ece6' }}>
                  <strong>{job.jobNumber} · {job.title || 'Untitled job'}</strong>
                  <span style={{ display: 'block', color: '#a89684', fontSize: 12, marginTop: 6 }}>{job.budgetUSDC} USDC · {job.status}</span>
                </button>
              ))}
              {!jobs.length && <p style={{ color: '#6b5a45' }}>No FlareHQ Jobs yet.</p>}
            </div>
          </div>

          <div style={card}>
            {!selected ? <p style={{ color: '#a89684' }}>Choose a job to view actions.</p> : <>
              <p style={{ color: '#c8975a', fontSize: 11, letterSpacing: 1 }}>{selected.jobNumber} · {selected.status}</p>
              <h2>{selected.title || 'FlareHQ Job'}</h2>
              <p style={{ color: '#d3c7b8', whiteSpace: 'pre-wrap' }}>{selected.description}</p>
              <p><strong>{selected.budgetUSDC} USDC</strong></p>
              <p style={{ color: '#6b5a45', fontSize: 11 }}>Client: {selected.clientAddress}<br />Provider: {selected.providerAddress ?? 'Not selected'}</p>
              {walletAction && <FlareHQExternalTransactions transactions={walletAction.transactions} confirm={walletAction.confirm} onDone={async () => { setWalletAction(null); await load(); }} />}

              {selected.status === 'OPEN' && <>
                <textarea value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="Your pitch" style={{ ...input, minHeight: 80 }} />
                <button style={button} disabled={!address || busy} onClick={() => act(`/api/flarehq-jobs/${selected.id}/apply`, { applicantAddress: address, pitch })}>Apply</button>
                {(selected.applications ?? []).map((app) => (
                  <div key={app.id} style={{ padding: 12, border: '1px solid #3d2e1a', borderRadius: 10, marginTop: 10 }}>
                    <p style={{ margin: '0 0 5px' }}>{app.pitch}</p><small>{app.applicantAddress}</small><br />
                    {address?.toLowerCase() === selected.clientAddress.toLowerCase() && <button style={{ ...button, marginTop: 8 }} onClick={() => act(`/api/flarehq-jobs/${selected.id}/select`, { applicationId: app.id })}>Select provider</button>}
                  </div>
                ))}
              </>}

              {selected.status === 'SELECTED' && address?.toLowerCase() === selected.clientAddress.toLowerCase() && <button style={button} onClick={() => act(`/api/flarehq-jobs/${selected.id}/fund`, {})}>Fund with FlareHQEscrow</button>}
              {selected.status === 'FUNDED' && address?.toLowerCase() === selected.providerAddress?.toLowerCase() && <><textarea value={deliverable} onChange={(e) => setDeliverable(e.target.value)} placeholder="Deliverable or evidence" style={{ ...input, minHeight: 100 }} /><button style={button} onClick={() => act(`/api/flarehq-jobs/${selected.id}/submit`, { deliverable })}>Submit work</button></>}
              {selected.status === 'SUBMITTED' && address?.toLowerCase() === selected.clientAddress.toLowerCase() && <button style={button} onClick={() => act(`/api/flarehq-jobs/${selected.id}/approve`, {})}>Approve submission</button>}
              {selected.status === 'SUBMITTED' && address?.toLowerCase() === selected.providerAddress?.toLowerCase() && <button style={button} onClick={() => act(`/api/flarehq-jobs/${selected.id}/release`, {})}>Accept release</button>}

              {['FUNDED', 'SUBMITTED'].includes(selected.status) && <>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Dispute reason" style={{ ...input, minHeight: 70 }} />
                <button style={{ ...button, background: '#9f453d' }} onClick={() => act(`/api/flarehq-jobs/${selected.id}/dispute`, { callerAddress: address, reason })}>Open dispute</button>
                {address?.toLowerCase() === selected.clientAddress.toLowerCase() && <button style={{ ...button, background: '#514336' }} onClick={() => act(`/api/flarehq-jobs/${selected.id}/refund`, {})}>Refund after expiry</button>}
              </>}
            </>}
          </div>
        </div>
      </section>
    </main>
  );
}

const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', marginBottom: 10, padding: 12, borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6' };
const button: React.CSSProperties = { width: '100%', padding: 12, border: 0, borderRadius: 10, background: '#c8975a', color: '#0e0b08', fontWeight: 800, cursor: 'pointer', marginTop: 6 };
const card: React.CSSProperties = { padding: 20, border: '1px solid #3d2e1a', borderRadius: 16, background: '#17110c' };
