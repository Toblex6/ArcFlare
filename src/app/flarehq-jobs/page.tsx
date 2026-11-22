'use client';

// Familiar Jobs workspace; the existing FlareHQEscrow lifecycle stays separate
// from ERC-8183/procurement/Telegram. No fake compatibility or default payer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import DashboardSidebar from '@/src/components/DashboardSidebar';
import FlareHQExternalTransactions, { type JobTransactionIntent } from '@/components/jobs/FlareHQExternalTransactions';
import { useSecurePinDialog } from '@/components/SecurePinDialog';
import { formatJobUnits, parseJobUnits } from '@/lib/jobs/flarehqJob';
import {
  jobViewFor,
  myJobsEmptyMessage,
  partitionMyJobs,
  resolveDefaultJobActor,
  sameJobAddress,
  shortJobAddress,
} from '@/lib/jobs/flarehqJobsView';
import styles from './jobs.module.css';

type Job = {
  id: string; jobNumber: string; title?: string | null; description: string;
  budgetUSDC: string; status: string; clientAddress: string; providerAddress?: string | null;
  deliverable?: string | null; escrowReference?: string | null;
  applications?: Array<{ id: string; applicantAddress: string; pitch: string; proposedAmount?: string | null; status?: string | null }>;
};
type Wallet = { address: string; mode: 'CIRCLE' | 'EXTERNAL'; source: string; actorType: string };
type Tab = 'board' | 'post' | 'manage' | 'mine';
type WalletAction = { transactions: JobTransactionIntent[]; confirm: { endpoint: string; body?: Record<string, unknown> } };
const same = sameJobAddress;

async function readJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.message ?? body.error ?? 'Request failed.');
  return body;
}

function AddressChip({ value, empty = 'Not selected' }: { value?: string | null; empty?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className={styles.muted}>{empty}</span>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard can be blocked; the truncated value stays visible */ }
  };
  return <span className={styles.addressChip}>
    <code>{shortJobAddress(value)}</code>
    <button type="button" className={styles.copyButton} aria-label={`Copy ${shortJobAddress(value)}`} onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  </span>;
}

function JobCard({ job, disabled, onOpen }: { job: Job; disabled: boolean; onOpen: (id: string) => void }) {
  return <button className={styles.jobCard} disabled={disabled} onClick={() => onOpen(job.id)}>
    <span className={styles.eyebrow}>{job.jobNumber} <span className={styles.badge}>{job.status}</span></span>
    <strong>{job.title || 'Untitled job'}</strong>
    <span className={styles.muted}>{job.description.slice(0, 160)}</span>
    <span><b>{job.budgetUSDC} USDC</b> · View job →</span>
  </button>;
}

export default function FlareHQJobsPage() {
  const { address } = useAccount();
  const { requestPin, dialog } = useSecurePinDialog();
  const [tab, setTab] = useState<Tab>('board');
  const [jobs, setJobs] = useState<Job[]>([]), [selected, setSelected] = useState<Job | null>(null);
  const [mineJobs, setMineJobs] = useState<Job[]>([]);
  const selectedId = useRef<string | null>(null), running = useRef(false);
  const [wallets, setWallets] = useState<Wallet[]>([]), [actorAddress, setActorAddress] = useState('');
  const actor = wallets.find((w) => same(w.address, actorAddress));
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [budget, setBudget] = useState('');
  const [pitch, setPitch] = useState(''), [deliverable, setDeliverable] = useState(''), [reason, setReason] = useState('');
  const [lookup, setLookup] = useState(''), [filter, setFilter] = useState('ALL');
  const [walletAction, setWalletAction] = useState<WalletAction | null>(null);

  const load = useCallback(async () => {
    const data = await readJson(await fetch('/api/flarehq-jobs?status=all&limit=100', { cache: 'no-store' }));
    setJobs(data.jobs ?? []);
    // List payloads do not necessarily contain applications. Refresh detail
    // independently instead of replacing it with a truncated board row.
    if (selectedId.current) {
      const detail = await readJson(await fetch(`/api/flarehq-jobs/${encodeURIComponent(selectedId.current)}`, { cache: 'no-store' }));
      setSelected(detail.job);
    }
  }, []);

  const loadMine = useCallback(async (viewer: string) => {
    if (!viewer) { setMineJobs([]); return; }
    const data = await readJson(await fetch(`/api/flarehq-jobs?status=all&limit=100&address=${encodeURIComponent(viewer)}`, { cache: 'no-store' }));
    setMineJobs(data.jobs ?? []);
  }, []);

  const loadWallets = useCallback(async () => {
    const data = await readJson(await fetch('/api/flarehq-jobs/wallets', { cache: 'no-store' }));
    setWallets(data.wallets ?? []);
  }, []);

  useEffect(() => {
    Promise.all([load(), loadWallets()]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [load, loadWallets]);

  // Auto-select the acting wallet when there is only one answer: the only
  // signed-in wallet, or the only wallet matching this job's client/provider/
  // applicant. An explicit valid choice is never overridden.
  useEffect(() => {
    setActorAddress((previous) => resolveDefaultJobActor(previous, wallets, selected));
  }, [wallets, selected]);

  // My Jobs follows the acting wallet immediately, including auto-selection.
  useEffect(() => {
    loadMine(actorAddress).catch((e) => setError(e.message));
  }, [actorAddress, loadMine]);

  async function refresh() {
    setLoading(true); setError(null);
    try { await Promise.all([load(), loadWallets(), loadMine(actorAddress)]); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function openJob(id: string) {
    if (busy || walletAction) return;
    setLoading(true); setError(null); setMessage(null);
    try {
      const data = await readJson(await fetch(`/api/flarehq-jobs/${encodeURIComponent(id)}`, { cache: 'no-store' }));
      selectedId.current = data.job.id; setSelected(data.job); setTab('manage');
      setPitch(''); setDeliverable(''); setReason('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function act(url: string, body: Record<string, unknown>) {
    if (running.current || walletAction || !actor) return;
    running.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      if (actor.mode === 'EXTERNAL' && !same(address, actor.address)) {
        throw new Error('Connect the browser wallet shown in Acting as. Sign in to that wallet at Consumer if it is not listed.');
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (actor.actorType === 'consumer' && /\/(?:select|fund|approve|release|refund|dispute)$/.test(url)) {
        const security = await readJson(await fetch('/api/consumer/security', { cache: 'no-store' }));
        if (!same(security.walletAddress, actor.address) || typeof security.hasPin !== 'boolean') throw new Error('Wallet security changed. Refresh your signed-in wallets.');
        if (security.hasPin) {
          const pin = await requestPin({ title: 'Authorize job action', description: 'Enter your payment PIN for the selected consumer wallet.', confirmLabel: 'Authorize' });
          if (pin === null) return;
          headers['x-consumer-pin'] = pin;
        }
      }
      const data = await readJson(await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }));
      if (data.job) { selectedId.current = data.job.id; setSelected(data.job); setTab('manage'); }
      if (data.pendingWallet) {
        const transactions = (data.transactions ?? (data.transaction ? [data.transaction] : [])) as JobTransactionIntent[];
        setWalletAction({ transactions, confirm: data.confirm ?? { endpoint: url, body } });
      } else setMessage('Action confirmed. The job state has been refreshed.');
      await load();
      return data;
    } catch (e: any) { setError(e.message || 'Could not complete this action.'); }
    finally { running.current = false; setBusy(false); }
  }

  const view = selected ? jobViewFor(selected, actor?.address) : null;
  const isClient = view?.role === 'client';
  const isProvider = view?.role === 'provider';
  const matchesFilter = (job: Job) => filter === 'ALL' || job.status === filter;
  const visibleJobs = jobs.filter(matchesFilter);
  const mine = partitionMyJobs(mineJobs, actor?.address);
  const postedJobs = mine.posted.filter(matchesFilter);
  const appliedJobs = mine.applied.filter(matchesFilter);
  let budgetPreview = '';
  try { budgetPreview = formatJobUnits(parseJobUnits(budget)); } catch { /* invalid input is not posted */ }
  const disabled = busy || !!walletAction || !actor;

  const statusFilter = <label>Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
    {['ALL', 'OPEN', 'SELECTED', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'REFUNDED'].map((s) => <option key={s}>{s}</option>)}
  </select></label>;

  return <div className={`light ${styles.page}`}>
    <DashboardSidebar active="Jobs" />
    <main className={styles.main}>
      <header className={styles.header}><div><h1>FlareHQ Jobs</h1>
        <p>Post work, choose a provider, and manage delivery and escrow in one place.</p></div>
        <button className={styles.secondary} disabled={busy || loading || !!walletAction} onClick={refresh}>↻ Refresh</button>
      </header>
      <section className={styles.identity} aria-label="Job wallet">
        <label htmlFor="job-actor">Acting as</label>
        {wallets.length > 1
          ? <select id="job-actor" value={actorAddress} disabled={busy || !!walletAction} onChange={(e) => { setActorAddress(e.target.value); setError(null); }}>
            <option value="">Choose a signed-in wallet</option>
            {wallets.map((w) => <option key={w.address} value={w.address}>{w.source} · {w.mode === 'CIRCLE' ? 'FlareHQ wallet' : 'browser wallet'} · {shortJobAddress(w.address)}</option>)}
          </select>
          : actor
            ? <div className={styles.identityValue}><AddressChip value={actor.address} /><span className={styles.muted}>Selected automatically.</span></div>
            : <p className={styles.muted}>Sign in with email or a browser wallet to post, apply, or manage a job.</p>}
        {actor && <p className={styles.muted}>{actor.mode === 'CIRCLE' ? 'Use your signed-in FlareHQ wallet. No browser-wallet connection is needed.' : 'You sign on-chain actions in this exact browser wallet.'}</p>}
        {!actor && wallets.length === 0 && <p className={styles.muted}><a href="/consumer">Sign in with email or a browser wallet</a>, then refresh here.</p>}
      </section>
      <nav className={styles.tabs} aria-label="Jobs workspace">
        {([['board', '📋 Job Board'], ['post', '📢 Post a Job'], ['manage', '🔧 Manage'], ['mine', '🗂️ My Jobs']] as const).map(([value, label]) =>
          <button key={value} aria-pressed={tab === value} disabled={busy || (!!walletAction && value !== 'manage')} onClick={() => setTab(value)}>{label}</button>)}
      </nav>
      {error && <div role="alert" className={styles.error}>{error}</div>}
      {message && <p role="status" className={styles.notice}>{message}</p>}

      {tab === 'board' && <section className={styles.card}>
        <div className={styles.sectionHead}><h2>Job Board</h2>{statusFilter}</div>
        <p className={styles.muted}>Showing the latest 100 jobs in this view.</p>
        {loading ? <p className={styles.muted}>Loading jobs…</p> : !visibleJobs.length ? <p className={styles.muted}>No jobs match this view.</p>
          : <div className={styles.jobGrid}>{visibleJobs.map((job) => <JobCard key={job.id} job={job} disabled={busy || !!walletAction} onOpen={openJob} />)}</div>}
      </section>}

      {tab === 'mine' && <section className={styles.card}>
        <div className={styles.sectionHead}><h2>My Jobs</h2>{statusFilter}</div>
        {loading ? <p className={styles.muted}>Loading jobs…</p> : <>
          <h3>Jobs I posted</h3>
          {postedJobs.length
            ? <div className={styles.jobGrid}>{postedJobs.map((job) => <JobCard key={job.id} job={job} disabled={busy || !!walletAction} onOpen={openJob} />)}</div>
            : <p className={styles.muted}>{myJobsEmptyMessage('posted', wallets.length)}</p>}
          <h3>Jobs I applied to</h3>
          {appliedJobs.length
            ? <div className={styles.jobGrid}>{appliedJobs.map((job) => <JobCard key={job.id} job={job} disabled={busy || !!walletAction} onOpen={openJob} />)}</div>
            : <p className={styles.muted}>{myJobsEmptyMessage('applied', wallets.length)}</p>}
        </>}
      </section>}

      {tab === 'post' && <section className={styles.card}>
        <h2>Post a Job</h2><p className={styles.muted}>Invite applications, review pitches, then select a provider before funding. The client pays the stated USDC budget plus network fees. A 0.25% release fee comes out of the provider payout.</p>
        <form className={styles.form} onSubmit={async (e) => { e.preventDefault(); if (!budgetPreview) return; const data = await act('/api/flarehq-jobs', { clientAddress: actor?.address, title, description, budget }); if (data?.job) { setTitle(''); setDescription(''); setBudget(''); } }}>
          <label>Title<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" /></label>
          <label>Describe the work<textarea required maxLength={10000} rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Scope, requirements, and what a successful delivery looks like" /></label>
          <label>Budget in USDC<input required inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 0.05" /></label>
          <p className={styles.muted}>{budgetPreview ? `Will be posted as ${budgetPreview} USDC. No funds move until you fund escrow.` : 'Enter a positive USDC amount with up to 6 decimals.'}</p>
          <button className={styles.primary} disabled={disabled || !budgetPreview || !description.trim()}>{busy ? 'Posting…' : 'Post Job'}</button>
        </form>
      </section>}

      {tab === 'manage' && <>
        <section className={styles.card}><h2>Manage Job</h2>
          <form className={styles.lookup} onSubmit={(e) => { e.preventDefault(); if (lookup.trim()) openJob(lookup.trim()); }}>
            <label>Job number or ID<input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="job123 or job ID" /></label>
            <button className={styles.primary} disabled={busy || loading || !!walletAction || !lookup.trim()}>Find job</button>
          </form>
        </section>
        {selected && view ? <section className={styles.card}>
          <div className={styles.sectionHead}><p className={styles.eyebrow}>{selected.jobNumber}</p><span className={styles.badge}>{selected.status}</span></div>
          <h2>{selected.title || 'FlareHQ Job'}</h2><p className={styles.description}>{selected.description}</p>
          <strong>{selected.budgetUSDC} USDC</strong>
          <dl className={styles.parties}>
            <dt>Client</dt><dd><AddressChip value={selected.clientAddress} /></dd>
            <dt>Provider</dt><dd><AddressChip value={selected.providerAddress} empty="Not selected" /></dd>
          </dl>
          {view.steps.length > 0 && <ol className={styles.progress} aria-label="Job lifecycle">
            {view.steps.map((step) => <li key={step.label} className={step.state === 'current' ? styles.stepCurrent : step.state === 'done' ? styles.stepDone : undefined}>{step.label}</li>)}
          </ol>}
          {selected.escrowReference && <p className={styles.muted}>Escrow reference: {selected.escrowReference}</p>}
          {selected.deliverable && <div className={styles.inset}><h3>Submitted work</h3><p className={styles.description}>{selected.deliverable}</p></div>}
          {walletAction && <div className={styles.inset}><FlareHQExternalTransactions transactions={walletAction.transactions} confirm={walletAction.confirm} consumerAddress={actor?.actorType === 'consumer' ? actor.address : undefined} onDone={async () => { setWalletAction(null); await load(); }} /></div>}

          {view.showApplyBox && <div className={styles.form}><h3>Apply for this job</h3><label>Your pitch<textarea rows={3} value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={5000} /></label><button className={styles.primary} disabled={disabled || !pitch.trim()} onClick={() => act(`/api/flarehq-jobs/${selected.id}/apply`, { applicantAddress: actor?.address, pitch })}>Apply</button></div>}

          {view.application && <div className={styles.inset} role="status"><h3>You applied</h3>
            <p className={styles.description}>{view.application.pitch}</p>
            <p className={styles.muted}>Status: {view.application.status ?? 'PENDING'}</p>
          </div>}

          {view.showApplications && <div className={styles.inset}><h3>Applications</h3>
            {!(selected.applications ?? []).length && <p className={styles.muted}>No applications yet. The provider must use a different wallet from the client.</p>}
            {(selected.applications ?? []).map((app) => <div key={app.id} className={styles.application}>
              <p className={styles.description}>{app.pitch}</p>
              <p className={styles.applicationMeta}><AddressChip value={app.applicantAddress} /><span className={styles.badge}>{app.status ?? 'PENDING'}</span></p>
              {view.showSelectProvider && <button className={styles.primary} disabled={disabled} onClick={() => act(`/api/flarehq-jobs/${selected.id}/select`, { applicationId: app.id })}>Select provider</button>}
            </div>)}
          </div>}

          {selected.status === 'SELECTED' && isClient && <div className={styles.inset}><p>You pay {selected.budgetUSDC} USDC into escrow plus network fees. Release pays the provider less the 0.25% release fee.</p><button className={styles.primary} disabled={disabled} onClick={() => act(`/api/flarehq-jobs/${selected.id}/fund`, {})}>Fund with FlareHQEscrow</button></div>}
          {selected.status === 'FUNDED' && isProvider && <div className={styles.form}><label>Deliverable or evidence<textarea rows={5} maxLength={50000} value={deliverable} onChange={(e) => setDeliverable(e.target.value)} /></label><button className={styles.primary} disabled={disabled || !deliverable.trim()} onClick={() => act(`/api/flarehq-jobs/${selected.id}/submit`, { deliverable })}>Submit work</button></div>}
          {selected.status === 'SUBMITTED' && (isClient || isProvider) && <div className={styles.inset}><p>Client approval and provider acceptance both confirm escrow delivery. The second confirmation releases payment; each party pays its network execution fee.</p>
            {isClient && <button className={styles.primary} disabled={disabled} onClick={() => act(`/api/flarehq-jobs/${selected.id}/approve`, {})}>Approve submission</button>}
            {isProvider && <button className={styles.primary} disabled={disabled} onClick={() => act(`/api/flarehq-jobs/${selected.id}/release`, {})}>Accept release</button>}
          </div>}
          {['FUNDED', 'SUBMITTED'].includes(selected.status) && (isClient || isProvider) && <details className={styles.inset}><summary>Dispute or expired-escrow refund</summary>
            <div className={styles.form}><label>Dispute reason<textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label><button className={styles.secondary} disabled={disabled || !reason.trim()} onClick={() => act(`/api/flarehq-jobs/${selected.id}/dispute`, { callerAddress: actor?.address, reason })}>Open dispute</button>
              {isClient && <><p className={styles.muted}>Refund is available only after the escrow deadline, and never during a dispute.</p><button className={styles.secondary} disabled={disabled} onClick={() => act(`/api/flarehq-jobs/${selected.id}/refund`, {})}>Refund after expiry</button></>}
            </div></details>}
          {view.role === 'visitor' && selected.status !== 'OPEN' && <p className={styles.muted}>Only the client and selected provider can manage this job.</p>}
        </section> : <section className={styles.card}><p className={styles.muted}>Choose a job from the board or look it up by number.</p></section>}
      </>}
      <footer className={styles.footer}>Funds are held in escrow on-chain; FlareHQ never holds them.</footer>
    </main>
    {dialog}
  </div>;
}
