'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import DashboardSidebar from '@/src/components/DashboardSidebar';
import FlareHQExternalTransactions, { type JobTransactionIntent } from '@/components/jobs/FlareHQExternalTransactions';

async function json(res: Response) { const body = await res.json().catch(() => ({})); if (!res.ok || body.success === false) throw new Error(body.message ?? body.error ?? 'Request failed.'); return body; }

export default function StreamsPage() {
  const { address } = useAccount();
  const [streams, setStreams] = useState<any[]>([]);
  const [worker, setWorker] = useState(''); const [budget, setBudget] = useState(''); const [count, setCount] = useState('4');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [walletAction, setWalletAction] = useState<{ transactions: JobTransactionIntent[]; confirm: any } | null>(null);
  const load = useCallback(async () => { try { const data = await json(await fetch('/api/streams', { cache: 'no-store' })); setStreams(data.streams ?? []); setError(null); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { if (address) load(); }, [address, load]);
  async function action(url: string, body: any) { setBusy(true); setError(null); try { const data = await json(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); if (data.pendingWallet) setWalletAction({ transactions: data.transactions ?? [data.transaction], confirm: data.confirm ?? { endpoint: url, body } }); else await load(); return data; } catch (e: any) { setError(e.message); } finally { setBusy(false); } }

  return <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', display: 'flex' }}>
    <DashboardSidebar active="Streams" />
    <section style={{ padding: '42px clamp(20px,4vw,64px)', flex: 1, maxWidth: 1050 }}>
      <p style={{ color: '#c8975a', letterSpacing: 2, fontSize: 11 }}>MILESTONE STREAMS</p><h1>Standalone tranche payments</h1>
      <p style={{ color: '#a89684', maxWidth: 720 }}>ArcFlareStream works independently of ERC-8183. Lock a USDC budget, release milestones, or close to pay every remaining tranche to the worker. Closing is not a refund.</p>
      {error && <p style={{ color: '#f87171', padding: 12, border: '1px solid #7f1d1d', borderRadius: 10 }}>{error}</p>}
      {walletAction && <FlareHQExternalTransactions transactions={walletAction.transactions} confirm={walletAction.confirm} onDone={async () => { setWalletAction(null); await load(); }} />}
      <div style={card}><h2>Create stream</h2><input style={input} value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="Worker address"/><input style={input} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Total USDC budget"/><input style={input} value={count} onChange={(e) => setCount(e.target.value)} placeholder="Tranche count (1–50)"/><button style={button} disabled={!address || busy} onClick={() => action('/api/streams', { posterAddress: address, workerAddress: worker, totalBudget: budget, trancheCount: Number(count) })}>Create milestone stream</button></div>
      <h2 style={{ marginTop: 30 }}>Your streams</h2>
      <div style={{ display: 'grid', gap: 12 }}>{streams.map((s) => <div key={s.reference} style={card}><strong>{s.totalBudgetUSDC} USDC · {s.status}</strong><p style={{ color: '#a89684', fontSize: 12 }}>{s.trancheCount} tranches · {s.tranchesReleased} released<br/>Worker: {s.workerAddress}</p>{s.status === 'ACTIVE' && s.posterAddress.toLowerCase() === address?.toLowerCase() && <><button style={button} onClick={() => { const raw = prompt(`Release tranche index (0–${s.trancheCount - 1})`); if (raw !== null) action(`/api/streams/${s.reference}/release`, { requirementIndex: Number(raw) }); }}>Release tranche</button><button style={{ ...button, background: '#9f453d' }} onClick={() => { if (confirm('Close pays ALL remaining funds to the worker. Continue?')) action(`/api/streams/${s.reference}/close`, {}); }}>Close and pay remainder</button></>}</div>)}</div>
    </section>
  </main>;
}
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', marginBottom: 10, padding: 12, border: '1px solid #3d2e1a', borderRadius: 10, background: '#251c12', color: '#f0ece6' };
const button: React.CSSProperties = { width: '100%', marginTop: 8, padding: 12, border: 0, borderRadius: 10, background: '#c8975a', color: '#0e0b08', fontWeight: 800 };
const card: React.CSSProperties = { marginTop: 16, padding: 20, border: '1px solid #3d2e1a', borderRadius: 16, background: '#17110c' };
