//src/app/jobs/page.tsx
'use client';

import DashboardSidebar from '@/src/components/DashboardSidebar';

import { useRouter } from 'next/navigation';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import {
  formatBudgetUsdc,
  getProviderNextAction,
  getProviderStatusColor,
  normalizeMineResponse,
  truncateAddress,
} from '@/src/lib/jobs/providerInbox';


const NAV = [
  { label: 'Dashboard', href: '/merchant/dashboard' },
  { label: 'Homepage', href: '/' },
  { label: 'Transactions', href: '/transactions' },
  { label: 'Checkout', href: '/merchant/dashboard#checkout' },
  { label: 'Escrow', href: '/escrow' },
  { label: 'Agents', href: '/agents' },
  { label: 'Jobs', href: '/jobs', active: true },
  { label: 'Support', href: '/support' },
];

const JOB_STATUSES = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];
// Manage-lookup badge map (GET /api/jobs?jobId= returns Title Case on-chain
// names). The /api/jobs/mine lists (provider + client inboxes) return canonical
// UPPERCASE DB statuses, so their badges use getProviderStatusColor(j.status)
// (case-insensitive, single normalization in lib/jobs/providerInbox) instead.
const STATUS_COLORS: Record<string, string> = {
  Open: 'var(--warning)',
  Funded: '#06b6d4',
  Submitted: 'var(--primary)',
  Completed: 'var(--success)',
  Rejected: 'var(--danger)',
  Expired: 'var(--text-secondary)',
};

interface JobResult {
  jobId: string;
  status: string;
  budgetUSDC: string;
  client: string;
  provider: string;
  description: string;
  txHash?: string;
  explorerUrl?: string;
  nextStep?: string;
  message?: string;
  warning?: string | null;
}

export default function JobsPage() {
  const _router = useRouter();
  React.useEffect(() => {
    // Auth gate + prefill the client (payer) wallet from the merchant's own
    // profile. The old hardcoded 0x7a8214… prefill was the shared PLATFORM
    // payer wallet — every create/fund attempt against it failed caller-control.
    fetch('/api/merchant/me')
      .then(async (r) => {
        if (r.status === 401) {
          _router.replace('/merchant/login');
          return null;
        }
        return r.json().catch(() => null);
      })
      .then((data) => {
        const addr = data?.merchant?.walletAddress;
        if (addr) setClientSCA(addr);
        const mId = data?.merchant?.id;
        if (mId) setMerchantId(mId);
      })
      .catch(() => _router.replace('/merchant/login'));
  }, []);

  const [activeTab, setActiveTab] = useState<'board' | 'create' | 'post' | 'manage' | 'mine'>('board');

  // Create flow state
  const [step, setStep] = useState(1);
  const [jobId, setJobId] = useState('');
  const [stepResult, setStepResult] = useState<JobResult | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepLoading, setStepLoading] = useState(false);

  // Create fields — clientSCA is prefilled from the merchant profile above
  const [clientSCA, setClientSCA] = useState('');
  const [walletBalance, setWalletBalance] = useState<string | null>(null);

  // Live USDC balance of the payer wallet so "transaction failed onchain"
  // surprises become visible before they happen.
  React.useEffect(() => {
    if (!clientSCA) return;
    let cancelled = false;
    fetch(`/api/merchant/wallet/balance?address=${clientSCA}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.success) setWalletBalance(d.balance);
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, [clientSCA]);
  const [providerSCA, setProviderSCA] = useState('');
  const [amountUSDC, setAmountUSDC] = useState('1.0');
  const [description, setDescription] = useState('');
  const [deadlineHours, setDeadlineHours] = useState('24');

  // Manage fields
  const [lookupJobId, setLookupJobId] = useState('');
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Submit/complete fields
  const [deliverable, setDeliverable] = useState('');
  const [manageProviderSCA, setManageProviderSCA] = useState('');
  const [manageClientSCA, setManageClientSCA] = useState('');
  const [manageAction, setManageAction] = useState<
    'submit' | 'complete' | 'fund' | 'approve' | 'accept' | null
  >(null);
  const [manageLoading, setManageLoading] = useState(false);
  const [manageResult, setManageResult] = useState<any>(null);
  const [manageError, setManageError] = useState<string | null>(null);

  // Post-a-Job (open procurement) state
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [postAgents, setPostAgents] = useState<any[]>([]);
  const [postAgentId, setPostAgentId] = useState('');
  const [postTitle, setPostTitle] = useState('');
  const [postDescription, setPostDescription] = useState('');
  const [postBudgetMax, setPostBudgetMax] = useState('');
  const [postSkill, setPostSkill] = useState('');
  const [postLoading, setPostLoading] = useState(false);
  const [postResult, setPostResult] = useState<any>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [myPostings, setMyPostings] = useState<any[]>([]);
  const [postingsLoading, setPostingsLoading] = useState(false);
  const [expandedPosting, setExpandedPosting] = useState<string | null>(null);
  const [applicants, setApplicants] = useState<any[]>([]);
  const [applicantsLoading, setApplicantsLoading] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null); // postingId being selected/hired

  // My Jobs tab — role-scoped read-only views over GET /api/jobs/mine.
  // The provider inbox ("Jobs for Me") loads role=provider so a directly-hired
  // provider discovers jobs where their controlled wallet is the providerSCA —
  // no hidden job id needed. The client section loads role=client. Both lists
  // are server-scoped by getCallerControlledAddresses; the backend tags each
  // row with isProvider/isClient. Role correctness note: hiding client-only
  // controls here is UX only — server-side authorization (caller-control
  // checks in the lifecycle routes) remains authoritative.
  const [mineRole, setMineRole] = useState<'provider' | 'client'>('provider');
  const [providerJobs, setProviderJobs] = useState<any[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [clientJobs, setClientJobs] = useState<any[]>([]);
  const [clientLoading, setClientLoading] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const loadMineRole = async (role: 'provider' | 'client') => {
    const setLoading = role === 'provider' ? setProviderLoading : setClientLoading;
    const setError = role === 'provider' ? setProviderError : setClientError;
    const setJobs = role === 'provider' ? setProviderJobs : setClientJobs;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/mine?role=${role}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || `Load failed (${res.status})`);
      // Malformed/empty payloads must not crash — normalize to a safe array.
      setJobs(normalizeMineResponse(data));
    } catch (e: any) {
      setError(e?.message || 'Load failed');
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };
  // Back-compat alias (old single-list loader): refresh the visible role list.
  const loadMyJobs = async () => {
    await loadMineRole(mineRole);
  };

  // Fetch when the My Jobs tab opens + when the role sub-tab switches (same
  // lazy-load pattern as the Post tab).
  React.useEffect(() => {
    if (activeTab === 'mine') {
      loadMineRole(mineRole);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, mineRole]);

  // Agent treasury funding (hire gate needs the agent's ledger treasury)
  const [agentTreasury, setAgentTreasury] = useState<any>(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [funding, setFunding] = useState(false);

  const callJobsAPI = async (body: any) => {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  };

  const runStep = async (action: string, extraBody: any = {}) => {
    setStepLoading(true);
    setStepError(null);
    try {
      const data = await callJobsAPI({ action, ...extraBody });
      setStepResult(data);
      if (data.jobId) setJobId(data.jobId);
      if (action === 'create') setStep(2);
      else if (action === 'setBudget') setStep(3);
      else if (action === 'approve') setStep(4);
      else if (action === 'fund') setStep(5);
      else if (action === 'submit') setStep(6);
      else if (action === 'complete') setStep(7);
    } catch (e: any) {
      setStepError(e.message);
    } finally {
      setStepLoading(false);
    }
  };

  const lookupJob = async () => {
    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const res = await fetch(`/api/jobs?jobId=${lookupJobId}`, {
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setLookupResult(data.job);
    } catch (e: any) {
      setLookupError(e.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const runManageAction = async () => {
    if (!manageAction) return;
    setManageLoading(true);
    setManageError(null);
    setManageResult(null);
    try {
      if (manageAction === 'accept') {
        // Provider-only Open + zero-budget task. Reuses the existing
        // POST /api/jobs/[jobId]/accept route (the same one the Provider Inbox
        // and Telegram /accept use) — all lifecycle, provider policy, and
        // caller-control authorization stay server-side; the provider's signing
        // wallet is resolved from the DB, never accepted from the body here.
        const budget = toUsdcSixDec(amountUSDC);
        if (!budget) throw new Error('Enter a valid budget (USDC) to accept the job.');
        const res = await fetch(`/api/jobs/${lookupJobId}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ budget }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setManageResult(data);
        await lookupJob(); // refresh job state (flags + budget update)
        return;
      }
      let body: any = { action: manageAction, jobId: lookupJobId };
      if (manageAction === 'submit')
        body = { ...body, providerSCA: manageProviderSCA, deliverable };
      if (manageAction === 'complete') body = { ...body, clientSCA: manageClientSCA };
      if (manageAction === 'fund') body = { ...body, clientSCA: manageClientSCA };
      if (manageAction === 'approve') body = { ...body, clientSCA: manageClientSCA, amountUSDC };
      const data = await callJobsAPI(body);
      setManageResult(data);
      await lookupJob(); // refresh job state
    } catch (e: any) {
      setManageError(e.message);
    } finally {
      setManageLoading(false);
    }
  };

  const loadMyAgents = async () => {
    try {
      const res = await fetch('/api/agents/discover?mine=1&status=ACTIVE_AGENT_PROVISIONED&limit=50');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load agents');
      setPostAgents(data.agents || []);
    } catch (e: any) {
      setPostError(e.message);
    }
  };

  // Normalize a USDC input to a 6-dec string so the API never interprets a
  // bare integer ("2") as micro-units. "2" -> "2.000000" (2 USDC).
  const toUsdcSixDec = (v: string): string => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return n.toFixed(6);
  };

  const createPosting = async () => {
    setPostLoading(true);
    setPostError(null);
    setPostResult(null);
    try {
      if (!postAgentId) throw new Error('Select a hiring agent (the payer/client for this job).');
      if (!postDescription.trim()) throw new Error('Enter a job description.');
      if (!postBudgetMax || Number(postBudgetMax) <= 0) throw new Error('Enter a max budget (USDC) greater than 0.');
      const res = await fetch('/api/procurement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientAgentId: Number(postAgentId),
          description: postDescription,
          title: postTitle || undefined,
          budgetMax: toUsdcSixDec(postBudgetMax),
          skill: postSkill || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Post failed (${res.status})`);
      setPostResult(data);
      setPostTitle('');
      setPostDescription('');
      setPostBudgetMax('');
      setPostSkill('');
      await loadPostings();
    } catch (e: any) {
      setPostError(e.message);
    } finally {
      setPostLoading(false);
    }
  };

  const loadPostings = async () => {
    setPostingsLoading(true);
    try {
      const [open, sel, hired] = await Promise.all([
        fetch('/api/procurement?status=OPEN'),
        fetch('/api/procurement?status=SELECTED'),
        fetch('/api/procurement?status=HIRED'),
      ]);
      const data = await Promise.all([open, sel, hired].map((r) => r.json()));
      const all: any[] = data.flatMap((d) => (d.success ? d.postings || [] : []));
      setMyPostings(
        merchantId
          ? all.filter((p) => String(p.merchantId) === String(merchantId))
          : all
      );
    } catch (e: any) {
      setPostError(e.message);
    } finally {
      setPostingsLoading(false);
    }
  };

  const toggleApplicants = async (postingId: string) => {
    if (expandedPosting === postingId) {
      setExpandedPosting(null);
      setApplicants([]);
      return;
    }
    setExpandedPosting(postingId);
    setApplicantsLoading(true);
    try {
      const res = await fetch(`/api/procurement/${postingId}/applicants`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'failed to load applicants');
      setApplicants(data.ranked || []);
    } catch (e: any) {
      setPostError(e.message);
      setApplicants([]);
    } finally {
      setApplicantsLoading(false);
    }
  };

  const selectAndHire = async (postingId: string, providerAddress: string) => {
    setSelecting(postingId);
    setPostError(null);
    try {
      const selRes = await fetch(`/api/procurement/${postingId}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerAddress }),
      });
      const selData = await selRes.json();
      if (!selRes.ok) throw new Error(selData.error || `Select failed (${selRes.status})`);
      const hireRes = await fetch(`/api/procurement/${postingId}/hire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const hireData = await hireRes.json();
      if (!hireRes.ok) throw new Error(hireData.error || `Hire failed (${hireRes.status})`);
      setPostResult({
        postingId,
        jobId: hireData.jobId,
        budget: hireData.budget,
        message: `Hired! Job #${hireData.jobId} created on-chain. The worker now sends /accept ${hireData.jobId} on Telegram, then you fund and complete from the Manage tab.`,
      });
      setExpandedPosting(null);
      setApplicants([]);
      await loadPostings();
    } catch (e: any) {
      setPostError(e.message);
    } finally {
      setSelecting(null);
    }
  };

  const loadTreasury = async (agentId: string) => {
    if (!agentId) {
      setAgentTreasury(null);
      return;
    }
    setTreasuryLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/treasury`);
      const data = await res.json();
      if (!res.ok || !data.treasury) throw new Error(data.error || 'failed to load treasury');
      setAgentTreasury(data.treasury);
    } catch (e: any) {
      setAgentTreasury(null);
    } finally {
      setTreasuryLoading(false);
    }
  };

  const fundTreasury = async () => {
    if (!postAgentId) return;
    const amount = window.prompt('Fund the agent treasury with how much USDC? (e.g. 5)', '5');
    if (!amount) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setPostError('Enter a positive USDC amount.');
      return;
    }
    setFunding(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/agents/${postAgentId}/treasury/credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountUSDC: n.toFixed(6) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Fund failed (${res.status})`);
      setPostResult({
        message: `Treasury funded: ${data.receivedUsdc} USDC received by the agent (tx ${(data.txHash || '').slice(0, 12)}…). You can now select & hire.`,
      });
      await loadTreasury(postAgentId);
    } catch (e: any) {
      setPostError(e.message);
    } finally {
      setFunding(false);
    }
  };

  // Load the merchant's agents + postings when the Post-a-Job tab opens
  React.useEffect(() => {
    if (activeTab === 'post' && merchantId) {
      loadMyAgents();
      loadPostings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, merchantId]);

  const S = {
    page: {
      display: 'flex',
      minHeight: '100vh',
      background: 'var(--background)',
      fontFamily: 'Inter, system-ui, sans-serif',
      color: 'var(--text)',
    },
    aside: {
      width: 220,
      minHeight: '100vh',
      background: 'var(--surface)',
      display: 'flex',
      flexDirection: 'column' as const,
      padding: '24px 14px',
      flexShrink: 0,
      position: 'sticky' as const,
      top: 0,
      height: '100vh',
      overflowY: 'auto' as const,
      borderRight: '1px solid var(--border)',
    },
    main: { flex: 1, padding: '32px', overflowX: 'hidden' as const },
    card: {
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 16,
      padding: 24,
      marginBottom: 20,
    },
    input: {
      width: '100%',
      padding: '10px 14px',
      background: 'var(--surface-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      color: 'var(--text)',
      fontSize: 13,
      fontFamily: 'monospace',
      outline: 'none',
      boxSizing: 'border-box' as const,
      marginBottom: 10,
    },
    btn: (disabled = false) => ({
      padding: '12px 24px',
      background: disabled ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
      color: disabled ? 'rgba(14,11,8,0.5)' : 'var(--background)',
      border: 'none',
      borderRadius: 10,
      fontWeight: 700,
      fontSize: 13,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }),
    btnSm: (active = false) => ({
      padding: '8px 14px',
      background: active ? 'rgba(200,151,90,0.15)' : 'transparent',
      color: active ? 'var(--primary)' : 'var(--text-secondary)',
      border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      borderRadius: 8,
      fontSize: 11,
      cursor: 'pointer',
      fontWeight: active ? 700 : 400,
    }),
    tab: (active: boolean) => ({
      padding: '8px 16px',
      borderRadius: 8,
      fontSize: 12,
      cursor: 'pointer',
      border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      background: active ? 'rgba(200,151,90,0.1)' : 'transparent',
      color: active ? 'var(--primary)' : 'var(--text-secondary)',
      fontWeight: active ? 700 : 400,
    }),
    label: {
      fontSize: 10,
      color: 'var(--text-secondary)',
      textTransform: 'uppercase' as const,
      letterSpacing: 1,
      marginBottom: 4,
      display: 'block' as const,
    },
    stepBox: (active: boolean, done: boolean) => ({
      background: done ? 'rgba(16,185,129,0.08)' : active ? 'rgba(200,151,90,0.08)' : 'var(--surface-secondary)',
      border: `1px solid ${done ? 'rgba(16,185,129,0.2)' : active ? 'rgba(200,151,90,0.3)' : 'var(--border)'}`,
      borderRadius: 14,
      padding: 18,
      marginBottom: 12,
    }),
  };

  const STEPS = [
    {
      num: 1,
      label: 'Create Job',
      action: 'create',
      desc: 'Client creates job with provider, description and deadline',
    },
    {
      num: 2,
      label: 'Set Budget',
      action: 'setBudget',
      desc: 'Provider sets the USDC price for the job',
    },
    {
      num: 3,
      label: 'Approve USDC',
      action: 'approve',
      desc: 'Client approves ERC-8183 contract to spend USDC',
    },
    {
      num: 4,
      label: 'Fund Escrow',
      action: 'fund',
      desc: 'Client locks USDC in the ERC-8183 escrow contract',
    },
    {
      num: 5,
      label: 'Submit Work',
      action: 'submit',
      desc: 'Provider submits deliverable hash onchain',
    },
    {
      num: 6,
      label: 'Complete Job',
      action: 'complete',
      desc: 'Client approves and releases payment to provider',
    },
    { num: 7, label: 'Done ✅', action: 'done', desc: 'Job completed — USDC released to provider' },
  ];

  return (
    <div className="light" style={S.page}>
      {/* Sidebar */}
      <DashboardSidebar active="Jobs" />

      {/* Main */}
      <main style={S.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
            ERC-8183 Job Board
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            Arc's native agentic commerce standard — create, fund, and complete jobs onchain
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' as const }}>
          {(
            [
              ['board', '📋 Job Board'],
              //['create', '🎯 Direct Hire'],
              ['post', '📢 Post a Job'],
              ['manage', '🔧 Manage'],
              ['mine', '🗂️ My Jobs'],
            ] as const
          ).map(([t, label]) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {label}
            </button>
          ))}
        </div>

        {/* ── BOARD TAB ── */}
        {activeTab === 'board' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>
              About ERC-8183
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
              ERC-8183 is Arc's native agentic commerce standard. It defines how AI agents create
              jobs, fund escrow with USDC, submit deliverables, and complete payments — all onchain
              with no middleman.
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 12,
                marginBottom: 20,
              }}
            >
              {[
                {
                  icon: '🤖',
                  title: 'Agent to Agent',
                  desc: 'AI agents hire other agents to complete tasks',
                },
                {
                  icon: '🔒',
                  title: 'Trustless Escrow',
                  desc: 'USDC locked in ERC-8183 contract until job is done',
                },
                {
                  icon: '⚡',
                  title: 'Arc Native',
                  desc: "Built on Arc's native agentic commerce standard",
                },
              ].map((f, i) => (
                <div
                  key={i}
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: 18,
                  }}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>{f.icon}</div>
                  <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>
                    {f.title}
                  </p>
                  <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: 0 }}>{f.desc}</p>
                </div>
              ))}
            </div>
            <div
              style={{
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 14,
                padding: 18,
                marginTop: 14,
              }}
            >
              <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: '0 0 10px' }}>
                Two ways to hire
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 14 }}>
                  <p style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 12, margin: '0 0 6px' }}>
                    🎯 Direct Hire
                  </p>
                  <p style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.5, margin: 0 }}>
                    You already know exactly who does the work (usually one of your agents). You name
                    their wallet, they sign their price and deliverable. Best for agents — paste their{' '}
                    <code>scaAddress</code> from the Marketplace card.
                  </p>
                  <button style={{ ...S.btnSm(false), marginTop: 10 }} onClick={() => setActiveTab('create')}>
                    Open Direct Hire →
                  </button>
                </div>
                <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 14 }}>
                  <p style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 12, margin: '0 0 6px' }}>
                    📢 Post a Job (workers apply on Telegram)
                  </p>
                  <p style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.5, margin: 0 }}>
                    You don't know the worker yet. Post an open job, workers discover it via Telegram{' '}
                    <code>/jobs</code> and apply with <code>/apply</code> — no wallet address needed up
                    front. You review ranked applicants, select, and hire; the worker then accepts and
                    sets the budget from Telegram.
                  </p>
                  <button style={{ ...S.btnSm(false), marginTop: 10 }} onClick={() => setActiveTab('post')}>
                    Open Post a Job →
                  </button>
                </div>
              </div>
            </div>
            <div
              style={{
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 14,
                padding: 18,
              }}
            >
              <p
                style={{
                  color: 'var(--primary)',
                  fontSize: 12,
                  fontWeight: 700,
                  margin: '0 0 10px',
                  fontFamily: 'monospace',
                }}
              >
                Contract Address
              </p>
              <p
                style={{
                  color: 'var(--text)',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  margin: '0 0 8px',
                  wordBreak: 'break-all',
                }}
              >
                0x0747EEf0706327138c69792bF28Cd525089e4583
              </p>
              <a
                href="https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--primary)', fontSize: 11 }}
              >
                View on ArcScan →
              </a>
            </div>
            <div style={{ marginTop: 16 }}>
              <button
                style={{ ...S.btn(), marginRight: 12 }}
                onClick={() => setActiveTab('create')}
              >
                🎯 Direct Hire
              </button>
              <button
                style={{ ...S.btn(), marginRight: 12, background: '#06b6d4' }}
                onClick={() => setActiveTab('post')}
              >
                📢 Post a Job
              </button>
              <button
                style={{
                  padding: '12px 24px',
                  background: 'transparent',
                  color: 'var(--primary)',
                  border: '1px solid var(--primary)',
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
                onClick={() => setActiveTab('manage')}
              >
                🔧 Manage Job
              </button>
            </div>
          </div>
        )}

        {/* ── CREATE TAB — step wizard ── */}
        {activeTab === 'create' && (
          <div>
            <div
              style={{
                background: 'rgba(200,151,90,0.08)',
                border: '1px solid rgba(200,151,90,0.25)',
                borderRadius: 12,
                padding: '12px 16px',
                marginBottom: 16,
              }}
            >
              <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>
                🎯 Direct Hire — you name the provider up front
              </p>
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                The provider's wallet is fixed on-chain when the job is created and must sign the
                budget and deliverable steps. Self-testing? Make the provider one of{' '}
                <strong>your own agents</strong> (their <code>scaAddress</code> from the Marketplace
                card) so this wizard can run end-to-end from this browser. To hire a worker you don't
                know yet, use <button style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }} onClick={() => setActiveTab('post')}>Post a Job</button> instead.
              </p>
            </div>
            {/* Progress */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
              {STEPS.slice(0, 6).map((s) => (
                <div
                  key={s.num}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    background: step > s.num ? 'var(--success)' : step === s.num ? 'var(--primary)' : 'var(--border)',
                  }}
                />
              ))}
            </div>

            {/* Step cards */}
            {STEPS.map((s) => {
              const isDone = step > s.num;
              const isActive = step === s.num;
              if (s.num > step + 0 || s.action === 'done') return null;
              return (
                <div key={s.num} style={S.stepBox(isActive, isDone)}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginBottom: isDone ? 0 : 14,
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: isDone ? 'var(--success)' : isActive ? 'var(--primary)' : 'var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 700,
                        color: isDone || isActive ? 'var(--background)' : 'var(--text-secondary)',
                        flexShrink: 0,
                      }}
                    >
                      {isDone ? '✓' : s.num}
                    </div>
                    <div>
                      <p
                        style={{
                          color: isDone ? 'var(--success)' : isActive ? 'var(--primary)' : 'var(--text-secondary)',
                          fontWeight: 700,
                          fontSize: 13,
                          margin: 0,
                        }}
                      >
                        {s.label}
                      </p>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: 0 }}>{s.desc}</p>
                    </div>
                    {isDone && stepResult?.explorerUrl && s.num === step - 1 && (
                      <a
                        href={stepResult.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          marginLeft: 'auto',
                          color: 'var(--primary)',
                          fontSize: 11,
                          fontFamily: 'monospace',
                        }}
                      >
                        ArcScan →
                      </a>
                    )}
                  </div>

                  {isActive && (
                    <div>
                      {/* Step 1: Create */}
                      {s.num === 1 && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <div>
                            <span style={S.label}>Your Client SCA</span>
                            <input
                              style={S.input}
                              value={clientSCA}
                              onChange={(e) => setClientSCA(e.target.value)}
                            />
                            <span style={{ fontSize: 11, color: walletBalance === null ? 'var(--text-secondary)' : parseFloat(walletBalance) > 0 ? '#0d7c5f' : '#dc2626' }}>
                              {clientSCA
                                ? walletBalance !== null
                                  ? `Payer wallet USDC balance: ${walletBalance}`
                                  : ''
                                : 'Prefilled from your merchant wallet'}
                            </span>
                          </div>
                          <div>
                            <span style={S.label}>Provider SCA</span>
                            <input
                              style={S.input}
                              value={providerSCA}
                              onChange={(e) => setProviderSCA(e.target.value)}
                              placeholder="0xProviderAddress"
                            />
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginTop: 2 }}>
                              Who you're giving this job to — the wallet that receives the escrowed
                              USDC and signs the budget/deliverable steps. For agents, copy the{' '}
                              <code>scaAddress</code> from the agent's card in the Marketplace. This
                              address is fixed on-chain at creation and can't be changed later. Human
                              workers aren't hired this way — use <strong>Post a Job</strong> instead
                              (they apply via Telegram and no address is needed up front).
                            </span>
                          </div>
                          <div>
                            <span style={S.label}>Amount (USDC)</span>
                            <input
                              style={S.input}
                              type="number"
                              value={amountUSDC}
                              onChange={(e) => setAmountUSDC(e.target.value)}
                            />
                          </div>
                          <div>
                            <span style={S.label}>Deadline (hours)</span>
                            <input
                              style={S.input}
                              type="number"
                              value={deadlineHours}
                              onChange={(e) => setDeadlineHours(e.target.value)}
                            />
                          </div>
                          <div style={{ gridColumn: '1/-1' }}>
                            <span style={S.label}>Job Description</span>
                            <input
                              style={S.input}
                              value={description}
                              onChange={(e) => setDescription(e.target.value)}
                              placeholder="Build streaming dashboard UI"
                            />
                          </div>
                        </div>
                      )}

                      {/* Step 2: Set Budget */}
                      {s.num === 2 && (
                        <div>
                          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                            Job ID: <strong style={{ color: 'var(--primary)' }}>#{jobId}</strong> —
                            Provider sets the price.
                          </p>
                          <p style={{ color: '#f59e0b', fontSize: 11, margin: '0 0 10px' }}>
                            ⚠️ This step is <strong>signed by the provider's wallet</strong> — the
                            worker named in step 1. It must be run from a session that controls that
                            wallet (for self-tests: your own agent's <code>scaAddress</code>). If you
                            get "You do not control the providerSCA wallet", the logged-in merchant
                            session doesn't own the address in this field.
                          </p>
                          <div>
                            <span style={S.label}>Provider SCA</span>
                            <input
                              style={S.input}
                              value={providerSCA}
                              onChange={(e) => setProviderSCA(e.target.value)}
                            />
                          </div>
                          <div>
                            <span style={S.label}>Budget (USDC)</span>
                            <input
                              style={S.input}
                              type="number"
                              value={amountUSDC}
                              onChange={(e) => setAmountUSDC(e.target.value)}
                            />
                          </div>
                        </div>
                      )}

                      {/* Step 3: Approve */}
                      {s.num === 3 && (
                        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                          Approving <strong style={{ color: 'var(--primary)' }}>{amountUSDC} USDC</strong>{' '}
                          for the ERC-8183 contract to spend from{' '}
                          <code style={{ color: '#06b6d4' }}>{clientSCA.slice(0, 12)}...</code>
                        </p>
                      )}

                      {/* Step 4: Fund */}
                      {s.num === 4 && (
                        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                          Locking <strong style={{ color: 'var(--primary)' }}>{amountUSDC} USDC</strong>{' '}
                          into ERC-8183 escrow for job{' '}
                          <strong style={{ color: 'var(--primary)' }}>#{jobId}</strong>.
                        </p>
                      )}

                      {/* Step 5: Submit */}
                      {s.num === 5 && (
                        <div>
                          <div>
                            <span style={S.label}>Provider SCA</span>
                            <input
                              style={S.input}
                              value={providerSCA}
                              onChange={(e) => setProviderSCA(e.target.value)}
                            />
                          </div>
                          <div>
                            <span style={S.label}>Deliverable Description</span>
                            <input
                              style={S.input}
                              value={deliverable}
                              onChange={(e) => setDeliverable(e.target.value)}
                              placeholder="Completed streaming dashboard — see PR #42"
                            />
                          </div>
                        </div>
                      )}

                      {/* Step 6: Complete */}
                      {s.num === 6 && (
                        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                          Completing job <strong style={{ color: 'var(--primary)' }}>#{jobId}</strong> and
                          releasing <strong style={{ color: 'var(--primary)' }}>{amountUSDC} USDC</strong>{' '}
                          to provider.
                        </p>
                      )}

                      {stepError && (
                        <p style={{ color: 'var(--danger)', fontSize: 12, margin: '8px 0' }}>
                          ❌ {stepError}
                        </p>
                      )}

                      {stepResult?.warning && (
                        <div
                          style={{
                            background: 'rgba(245,158,11,0.08)',
                            border: '1px solid rgba(245,158,11,0.3)',
                            borderRadius: 10,
                            padding: '8px 12px',
                            marginTop: 8,
                          }}
                        >
                          <span style={{ color: '#f59e0b', fontSize: 12 }}>⚠️ {stepResult.warning}</span>
                        </div>
                      )}

                      <button
                        style={{ ...S.btn(stepLoading), marginTop: 8 }}
                        disabled={stepLoading}
                        onClick={() => {
                          if (s.num === 1)
                            runStep('create', {
                              clientSCA,
                              providerSCA,
                              amountUSDC,
                              description,
                              deadlineHours: parseInt(deadlineHours),
                            });
                          else if (s.num === 2)
                            runStep('setBudget', { jobId, providerSCA, amountUSDC });
                          else if (s.num === 3)
                            runStep('approve', { jobId, clientSCA, amountUSDC });
                          else if (s.num === 4) runStep('fund', { jobId, clientSCA });
                          else if (s.num === 5)
                            runStep('submit', { jobId, providerSCA, deliverable });
                          else if (s.num === 6) runStep('complete', { jobId, clientSCA });
                        }}
                      >
                        {stepLoading ? 'Sending to Arc Testnet...' : `Execute: ${s.label}`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Completed */}
            {step === 7 && stepResult && (
              <div
                style={{
                  background: 'rgba(16,185,129,0.06)',
                  border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: 16,
                  padding: 28,
                  textAlign: 'center',
                }}
              >
                <p style={{ fontSize: 32, marginBottom: 8 }}>🎉</p>
                <p style={{ color: 'var(--success)', fontWeight: 800, fontSize: 18, margin: '0 0 8px' }}>
                  Job Completed!
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 16px' }}>
                  {stepResult.message}
                </p>
                {stepResult.explorerUrl && (
                  <a
                    href={stepResult.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--primary)', fontFamily: 'monospace', fontSize: 12 }}
                  >
                    View final tx on ArcScan →
                  </a>
                )}
                <div style={{ marginTop: 20 }}>
                  <button
                    style={{ ...S.btn(), marginRight: 12 }}
                    onClick={() => {
                      setStep(1);
                      setJobId('');
                      setStepResult(null);
                    }}
                  >
                    Create Another Job
                  </button>
                  <button
                    style={{
                      padding: '12px 24px',
                      background: 'transparent',
                      color: 'var(--primary)',
                      border: '1px solid var(--primary)',
                      borderRadius: 10,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setActiveTab('manage');
                      setLookupJobId(jobId);
                    }}
                  >
                    View Job Details
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── POST A JOB TAB — open procurement ── */}
        {activeTab === 'post' && (
          <div>
            <div style={S.card}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>
                📢 Post a Job for Workers
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6, margin: '0 0 16px' }}>
                Workers discover and apply through Telegram (<code>/jobs</code>,{' '}
                <code>/apply &lt;jobId&gt; &quot;&lt;your pitch&gt;&quot;</code> — e.g.{' '}
                <code>/apply job112 &quot;I can build this in 2 days&quot;</code>). You review ranked
                applicants, select the best, then hire — no wallet address is needed up front. After
                hiring, the worker sets their budget from Telegram (<code>/accept</code>), then you
                fund and complete from the Manage tab.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <span style={S.label}>Hiring Agent (client)</span>
                  <select
                    style={{ ...S.input, marginBottom: 0, fontFamily: 'monospace' }}
                    value={postAgentId}
                    onChange={(e) => {
                      setPostAgentId(e.target.value);
                      loadTreasury(e.target.value);
                    }}
                  >
                    <option value="">Select your agent...</option>
                    {postAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name || `Agent #${a.id}`} ({a.scaAddress?.slice(0, 10)}…)
                      </option>
                    ))}
                  </select>
                  {postAgents.length === 0 && (
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginTop: 4 }}>
                      No active agents found. Deploy an agent first (Agents / Marketplace).
                    </span>
                  )}
                  {postAgentId && (
                    <div style={{ marginTop: 8, fontSize: 11 }}>
                      {treasuryLoading ? (
                        <span style={{ color: 'var(--text-secondary)' }}>Loading treasury...</span>
                      ) : agentTreasury ? (
                        <span style={{ color: 'var(--text-secondary)', display: 'block' }}>
                          Agent treasury available:{' '}
                          <strong style={{ color: Number(agentTreasury.availableBalance) > 0 ? '#0d7c5f' : '#dc2626' }}>
                            {(Number(agentTreasury.availableBalance) / 1e6).toFixed(4)} USDC
                          </strong>{' '}
                          {postBudgetMax && Number(postBudgetMax) > 0 && Number(agentTreasury.availableBalance) / 1e6 < Number(postBudgetMax) && (
                            <span style={{ color: '#f59e0b', display: 'block', marginTop: 2 }}>
                              Below the budget — hire will be blocked until you fund it.{' '}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-secondary)' }}>Treasury unavailable.</span>
                      )}
                      <button
                        style={{ ...S.btnSm(false), marginTop: 6, color: 'var(--primary)', fontWeight: 700 }}
                        disabled={funding}
                        onClick={fundTreasury}
                      >
                        {funding ? 'Funding...' : 'Fund agent treasury (USDC)'}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <span style={S.label}>Max Budget (USDC)</span>
                  <input
                    style={S.input}
                    type="number"
                    min="0"
                    step="0.01"
                    value={postBudgetMax}
                    onChange={(e) => setPostBudgetMax(e.target.value)}
                    placeholder="5.00"
                  />
                  <span style={{ fontSize: 11, color: postBudgetMax && Number(postBudgetMax) > 0 ? '#0d7c5f' : 'var(--text-secondary)', display: 'block', marginTop: 2 }}>
                    {postBudgetMax && Number(postBudgetMax) > 0
                      ? `Will be posted as ${Number(postBudgetMax).toFixed(2)} USDC`
                      : 'Enter an amount in USDC'}
                  </span>
                </div>
                <div>
                  <span style={S.label}>Title (optional)</span>
                  <input
                    style={S.input}
                    value={postTitle}
                    onChange={(e) => setPostTitle(e.target.value)}
                    placeholder="Security review of swap pool"
                  />
                </div>
                <div>
                  <span style={S.label}>Skill (optional)</span>
                  <input
                    style={S.input}
                    value={postSkill}
                    onChange={(e) => setPostSkill(e.target.value)}
                    placeholder="security-review"
                  />
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <span style={S.label}>Description</span>
                  <input
                    style={S.input}
                    value={postDescription}
                    onChange={(e) => setPostDescription(e.target.value)}
                    placeholder="Describe the work workers will bid on"
                  />
                </div>
              </div>
              {postError && (
                <p style={{ color: 'var(--danger)', fontSize: 12, margin: '8px 0' }}>❌ {postError}</p>
              )}
              {postResult && (
                <div
                  style={{
                    background: 'rgba(16,185,129,0.06)',
                    border: '1px solid rgba(16,185,129,0.2)',
                    borderRadius: 10,
                    padding: 12,
                    marginTop: 8,
                  }}
                >
                  <p style={{ color: 'var(--success)', fontWeight: 700, fontSize: 12, margin: '0 0 4px' }}>
                    {postResult.jobId ? `✅ ${postResult.message}` : '✅ Job posted!'}
                  </p>
                  {!postResult.jobId && postResult.posting?.id && (
                    <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                      Sharing id: <code>job{postResult.posting.seq}</code> — workers apply with{' '}
                      <code>/apply job{postResult.posting.seq} &quot;your pitch in quotes&quot;</code> on Telegram.
                    </p>
                  )}
                </div>
              )}
              <button
                style={{ ...S.btn(postLoading), marginTop: 8, marginRight: 8 }}
                disabled={postLoading}
                onClick={() => {
                  if (postAgents.length === 0) loadMyAgents();
                  createPosting();
                }}
              >
                {postLoading ? 'Posting...' : 'Post Job'}
              </button>
              <button style={S.btnSm(false)} onClick={() => { loadMyAgents(); loadPostings(); }}>
                Load Agents & Refresh
              </button>
            </div>

            <div style={S.card}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                  My Postings
                </h3>
                <button style={S.btnSm(false)} onClick={loadPostings}>
                  {postingsLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>
              {!postingsLoading && myPostings.length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                  No postings yet. Post one above.
                </p>
              )}
              {myPostings.map((p) => (
                <div
                  key={p.id}
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>
                        {p.title || p.description?.slice(0, 60) || 'Untitled'}
                        <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)', fontWeight: 400, fontSize: 11 }}>
                          {' '}(job{p.seq})
                        </span>
                      </p>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: 0 }}>
                        Budget up to {(() => { try { return (Number(p.budgetMax) / 1e6).toFixed(2); } catch { return '?'; } })()} USDC
                        {p.skill ? ` · skill: ${p.skill}` : ''}
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '3px 10px',
                        borderRadius: 20,
                        fontWeight: 700,
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'nowrap' as const,
                      }}
                    >
                      {p.status}
                    </span>
                  </div>
                  {p.status === 'OPEN' && (
                    <button
                      style={{ ...S.btnSm(expandedPosting === p.id), marginTop: 12 }}
                      onClick={() => toggleApplicants(p.id)}
                    >
                      {expandedPosting === p.id ? 'Hide Applicants' : 'View Applicants'}
                    </button>
                  )}
                  {p.status === 'SELECTED' && (
                    <button
                      style={{ ...S.btnSm(false), marginTop: 12, color: 'var(--primary)', fontWeight: 700 }}
                      disabled={selecting === p.id}
                      onClick={() => selectAndHire(p.id, p.selectedProviderSCA)}
                    >
                      {selecting === p.id ? 'Hiring...' : 'Hire Selected Worker'}
                    </button>
                  )}
                  {p.status === 'HIRED' && p.resultingJobId && (
                    <p style={{ color: '#06b6d4', fontSize: 12, margin: '12px 0 0' }}>
                      Hired → job #{p.resultingJobId}. Worker sends{' '}
                      <code>/accept {p.resultingJobId}</code> on Telegram, then fund & complete from
                      the Manage tab.
                    </p>
                  )}
                  {expandedPosting === p.id && (
                    <div style={{ marginTop: 12 }}>
                      {applicantsLoading ? (
                        <p style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Loading applicants...</p>
                      ) : applicants.length === 0 ? (
                        <p style={{ color: 'var(--text-secondary)', fontSize: 11 }}>No applicants yet.</p>
                      ) : (
                        applicants.map((a, i) => (
                          <div
                            key={a.applicantAddress}
                            style={{
                              background: 'var(--surface)',
                              border: '1px solid var(--border)',
                              borderRadius: 10,
                              padding: 12,
                              marginBottom: 8,
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 12,
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <p style={{ color: 'var(--text)', fontSize: 12, margin: '0 0 4px', fontWeight: 700 }}>
                                #{i + 1} · score {a.score}
                                <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)', fontWeight: 400 }}>
                                  {' '}{a.applicantAddress?.slice(0, 14)}…
                                </span>
                              </p>
                              <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: 0 }}>
                                {a.pitch?.slice(0, 120)}
                                {a.proposedAmount ? ` · bid ${(Number(a.proposedAmount) / 1e6).toFixed(4)} USDC` : ''}
                              </p>
                            </div>
                            <button
                              style={{ ...S.btnSm(false), whiteSpace: 'nowrap' as const, color: 'var(--primary)', fontWeight: 700 }}
                              disabled={selecting === p.id}
                              onClick={() => selectAndHire(p.id, a.applicantAddress)}
                            >
                              {selecting === p.id ? 'Working...' : 'Select & Hire'}
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── MY JOBS TAB — provider inbox (read-only over GET /api/jobs/mine) ── */}
        {activeTab === 'mine' && (
          <div style={S.card}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                🗂️ My Jobs
              </h3>
              <button
                style={S.btnSm(false)}
                onClick={loadMyJobs}
                disabled={mineRole === 'provider' ? providerLoading : clientLoading}
              >
                {(mineRole === 'provider' ? providerLoading : clientLoading) ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6, margin: '0 0 12px' }}>
              Jobs discovered through your own controlled wallets — no hidden job id needed.
              The lists below are server-scoped: you only ever see jobs where you are the
              provider or the client. To act on a job, open it in the Manage tab.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' as const }}>
              <button style={S.tab(mineRole === 'provider')} onClick={() => setMineRole('provider')}>
                💼 Jobs for Me (Provider)
              </button>
              <button style={S.tab(mineRole === 'client')} onClick={() => setMineRole('client')}>
                🧑‍💼 Jobs I Posted (Client)
              </button>
            </div>
            {mineRole === 'provider' ? (
              <div>
                <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
                  💼 Jobs for Me — Provider Inbox
                </h4>
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6, margin: '0 0 16px' }}>
                  Direct-hire jobs where one of your controlled wallets is the provider
                  (<code>GET /api/jobs/mine?role=provider</code>). If a client hired you,
                  the job appears here automatically.
                </p>
                {providerLoading && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                    Loading your provider jobs...
                  </p>
                )}
                {providerError && (
                  <div>
                    <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 4px' }}>
                      ❌ {providerError}
                    </p>
                    {providerError.toLowerCase().includes('auth') && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 8px' }}>
                        You are not logged in.{' '}
                        <a href="/merchant/login" style={{ color: 'var(--primary)' }}>
                          Log in as merchant →
                        </a>
                      </p>
                    )}
                  </div>
                )}
                {!providerLoading && !providerError && providerJobs.length === 0 && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                    No provider jobs yet. If a client hired you, the job appears here
                    automatically — ask the client to confirm they used your provider
                    wallet address.
                  </p>
                )}
                {providerJobs.map((j: any) => {
                  const next = getProviderNextAction(j);
                  const needsAction = next.kind === 'accept' || next.kind === 'submit';
                  return (
                    <div
                      key={j.id ?? j.jobId}
                      style={{
                        background: 'var(--surface-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        padding: 16,
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>
                            Job #{j.jobId}{' '}
                            <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 11 }}>
                              · {formatBudgetUsdc(j.budget)}
                            </span>
                          </p>
                          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 8px', lineHeight: 1.5 }}>
                            {j.description || 'No description provided.'}
                          </p>
                          <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: '0 0 8px', fontFamily: 'monospace' }}>
                            Client: {truncateAddress(j.clientSCA)}
                          </p>
                          {j.deliverableHash && (
                            <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: '0 0 8px', fontFamily: 'monospace' }}>
                              Deliverable submitted: {String(j.deliverableHash).slice(0, 18)}…
                            </p>
                          )}
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                            <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 20, fontWeight: 700, background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.3)', color: '#06b6d4', whiteSpace: 'nowrap' as const }}>
                              🙋 Hired for this job
                            </span>
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: 10,
                            padding: '3px 10px',
                            borderRadius: 20,
                            fontWeight: 700,
                            background: `${getProviderStatusColor(j.status)}15`,
                            color: getProviderStatusColor(j.status),
                            border: `1px solid ${getProviderStatusColor(j.status)}30`,
                            whiteSpace: 'nowrap' as const,
                          }}
                        >
                          {j.status}
                        </span>
                      </div>
                      <div
                        style={{
                          background: needsAction ? 'rgba(200,151,90,0.08)' : 'var(--surface)',
                          border: `1px solid ${needsAction ? 'rgba(200,151,90,0.3)' : 'var(--border)'}`,
                          borderRadius: 10,
                          padding: '10px 12px',
                          marginTop: 12,
                        }}
                      >
                        <p style={{ color: needsAction ? 'var(--primary)' : 'var(--text)', fontWeight: 700, fontSize: 12, margin: '0 0 4px' }}>
                          {needsAction ? '👉 ' : ''}{next.title}
                        </p>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.5, margin: 0 }}>
                          {next.detail}
                        </p>
                      </div>
                      {/* Provider role shows provider actions only. Client-only
                          controls (approve / fund / complete) are intentionally
                          absent here — the server remains authoritative and
                          rejects any action the caller does not control. */}
                      <button
                        style={{ ...S.btnSm(false), marginTop: 12, color: 'var(--primary)', fontWeight: 700 }}
                        onClick={() => {
                          setLookupJobId(String(j.jobId));
                          setActiveTab('manage');
                        }}
                      >
                        Manage this job →
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
                  🧑‍💼 Jobs I Posted — Client View
                </h4>
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6, margin: '0 0 16px' }}>
                  Direct-hire jobs where one of your controlled wallets is the client
                  (<code>GET /api/jobs/mine?role=client</code>). Fund and complete them
                  from the Manage tab.
                </p>
                {clientLoading && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                    Loading your client jobs...
                  </p>
                )}
                {clientError && (
                  <div>
                    <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 4px' }}>
                      ❌ {clientError}
                    </p>
                    {clientError.toLowerCase().includes('auth') && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 8px' }}>
                        You are not logged in.{' '}
                        <a href="/merchant/login" style={{ color: 'var(--primary)' }}>
                          Log in as merchant →
                        </a>
                      </p>
                    )}
                  </div>
                )}
                {!clientLoading && !clientError && clientJobs.length === 0 && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                    No client jobs yet. To hire someone, use{' '}
                    <button
                      style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
                      onClick={() => setActiveTab('post')}
                    >
                      Post a Job
                    </button>
                    .
                  </p>
                )}
                {clientJobs.map((j: any) => (
                  <div
                    key={j.id ?? j.jobId}
                    style={{
                      background: 'var(--surface-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 12,
                      padding: 16,
                      marginBottom: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>
                          Job #{j.jobId}{' '}
                          <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 11 }}>
                            · {formatBudgetUsdc(j.budget)}
                          </span>
                        </p>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 8px', lineHeight: 1.5 }}>
                          {j.description || 'No description provided.'}
                        </p>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: '0 0 8px', fontFamily: 'monospace' }}>
                          Provider: {truncateAddress(j.providerSCA)}
                        </p>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                          <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 20, fontWeight: 700, background: 'rgba(200,151,90,0.08)', border: '1px solid rgba(200,151,90,0.3)', color: 'var(--primary)', whiteSpace: 'nowrap' as const }}>
                            🧑‍💼 Managing this job
                          </span>
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          padding: '3px 10px',
                          borderRadius: 20,
                          fontWeight: 700,
                          background: `${getProviderStatusColor(j.status)}15`,
                          color: getProviderStatusColor(j.status),
                          border: `1px solid ${getProviderStatusColor(j.status)}30`,
                          whiteSpace: 'nowrap' as const,
                        }}
                      >
                        {j.status}
                      </span>
                    </div>
                    <button
                      style={{ ...S.btnSm(false), marginTop: 12, color: 'var(--primary)', fontWeight: 700 }}
                      onClick={() => {
                        setLookupJobId(String(j.jobId));
                        setActiveTab('manage');
                      }}
                    >
                      Manage this job →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── MANAGE TAB ── */}
        {activeTab === 'manage' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 16px' }}>
              Look Up Job
            </h3>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <input
                style={{ ...S.input, marginBottom: 0, flex: 1 }}
                value={lookupJobId}
                onChange={(e) => setLookupJobId(e.target.value)}
                placeholder="Job ID e.g. 1"
              />
              <button
                style={{ ...S.btn(lookupLoading), whiteSpace: 'nowrap' as const }}
                disabled={lookupLoading}
                onClick={lookupJob}
              >
                {lookupLoading ? 'Loading...' : 'Look Up Job'}
              </button>
            </div>
            {lookupError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>❌ {lookupError}</p>}

            {lookupResult && (
              <div>
                {/* Job card */}
                <div
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: 20,
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: 14,
                    }}
                  >
                    <div>
                      <p
                        style={{
                          color: 'var(--text)',
                          fontWeight: 700,
                          fontSize: 16,
                          margin: '0 0 4px',
                        }}
                      >
                        Job #{lookupResult.jobId}
                      </p>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>
                        {lookupResult.description}
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        padding: '4px 12px',
                        borderRadius: 20,
                        fontWeight: 700,
                        background: `${STATUS_COLORS[lookupResult.status] || 'var(--text-secondary)'}15`,
                        color: STATUS_COLORS[lookupResult.status] || 'var(--text-secondary)',
                        border: `1px solid ${STATUS_COLORS[lookupResult.status] || 'var(--text-secondary)'}30`,
                      }}
                    >
                      {lookupResult.status}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {[
                      { label: 'Budget', value: `${lookupResult.budgetUSDC} USDC` },
                      {
                        label: 'Expires',
                        value: lookupResult.isExpired
                          ? '⚠ Expired'
                          : new Date(lookupResult.expiredAt).toLocaleDateString(),
                      },
                      { label: 'Client', value: `${lookupResult.client?.slice(0, 12)}...` },
                      { label: 'Provider', value: `${lookupResult.provider?.slice(0, 12)}...` },
                    ].map((row) => (
                      <div
                        key={row.label}
                        style={{ background: 'var(--surface)', borderRadius: 8, padding: 10 }}
                      >
                        <span
                          style={{
                            fontSize: 9,
                            color: 'var(--text-secondary)',
                            textTransform: 'uppercase',
                            letterSpacing: 1,
                            display: 'block',
                            marginBottom: 3,
                          }}
                        >
                          {row.label}
                        </span>
                        <span style={{ color: 'var(--text)', fontSize: 12, fontFamily: 'monospace' }}>
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Actions based on status */}
                {lookupResult.status !== 'Completed' && lookupResult.status !== 'Rejected' && (
                  <div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                      Available Actions:
                    </p>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap' as const,
                        marginBottom: 16,
                      }}
                    >
                      {lookupResult.status === 'Open' && (
                        <button
                          style={S.btnSm(manageAction === 'approve')}
                          onClick={() => setManageAction('approve')}
                        >
                          Approve USDC
                        </button>
                      )}
                      {lookupResult.status === 'Open' && (
                        <button
                          style={S.btnSm(manageAction === 'fund')}
                          onClick={() => setManageAction('fund')}
                        >
                          Fund Escrow
                        </button>
                      )}
                      {lookupResult.status === 'Open' &&
                        lookupResult.budgetZero &&
                        lookupResult.isProvider && (
                          <button
                            style={S.btnSm(manageAction === 'accept')}
                            onClick={() => setManageAction('accept')}
                          >
                            Accept / Set Budget
                          </button>
                        )}
                      {lookupResult.status === 'Funded' && (
                        <button
                          style={S.btnSm(manageAction === 'submit')}
                          onClick={() => setManageAction('submit')}
                        >
                          Submit Deliverable
                        </button>
                      )}
                      {lookupResult.status === 'Submitted' && (
                        <button
                          style={S.btnSm(manageAction === 'complete')}
                          onClick={() => setManageAction('complete')}
                        >
                          Complete & Pay
                        </button>
                      )}
                    </div>

                    {manageAction && (
                      <div
                        style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                          padding: 16,
                        }}
                      >
                        {(manageAction === 'approve' ||
                          manageAction === 'fund' ||
                          manageAction === 'complete') && (
                            <div>
                              {/* Role-correctness audit: approve/fund/complete are all
                                  client-signed (body.clientSCA) — never provider-facing.
                                  Dynamic label so the signer is explicit per action.
                                  State/API mapping unchanged: manageClientSCA → clientSCA. */}
                              <span
                                style={{
                                  fontSize: 10,
                                  color: 'var(--text-secondary)',
                                  textTransform: 'uppercase',
                                  letterSpacing: 1,
                                  marginBottom: 4,
                                  display: 'block',
                                }}
                              >
                                Client Wallet — signs {manageAction}
                              </span>
                              <input
                                style={S.input}
                                value={manageClientSCA}
                                onChange={(e) => setManageClientSCA(e.target.value)}
                                placeholder="0xClientAddress"
                              />
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 10 }}>
                                You (the client/payer) sign this from the wallet named as client
                                on-chain. If you get a caller-control error, the logged-in session
                                doesn't own this address.
                              </span>
                            </div>
                          )}
                        {manageAction === 'approve' && (
                          <div>
                            <span
                              style={{
                                fontSize: 10,
                                color: 'var(--text-secondary)',
                                textTransform: 'uppercase',
                                letterSpacing: 1,
                                marginBottom: 4,
                                display: 'block',
                              }}
                            >
                              Amount USDC
                            </span>
                            <input
                              style={S.input}
                              value={amountUSDC}
                              onChange={(e) => setAmountUSDC(e.target.value)}
                            />
                          </div>
                        )}
                        {manageAction === 'submit' && (
                          <>
                            <div>
                              {/* Role-correctness audit: submit is provider-signed
                                  (body.providerSCA) — never client-facing. "Provider SCA"
                                  renamed to "Provider Wallet" for plain language.
                                  State/API mapping unchanged: manageProviderSCA → providerSCA. */}
                              <span
                                style={{
                                  fontSize: 10,
                                  color: 'var(--text-secondary)',
                                  textTransform: 'uppercase',
                                  letterSpacing: 1,
                                  marginBottom: 4,
                                  display: 'block',
                                }}
                              >
                                Provider Wallet — signs submit
                              </span>
                              <input
                                style={S.input}
                                value={manageProviderSCA}
                                onChange={(e) => setManageProviderSCA(e.target.value)}
                                placeholder="0xProviderAddress"
                              />
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 10 }}>
                                The worker named at creation signs this from their wallet. Must
                                be run from a session that controls that address.
                              </span>
                            </div>
                            <div>
                              <span
                                style={{
                                  fontSize: 10,
                                  color: 'var(--text-secondary)',
                                  textTransform: 'uppercase',
                                  letterSpacing: 1,
                                  marginBottom: 4,
                                  display: 'block',
                                }}
                              >
                                Deliverable
                              </span>
                              <input
                                style={S.input}
                                value={deliverable}
                                onChange={(e) => setDeliverable(e.target.value)}
                                placeholder="Completed work description"
                              />
                            </div>
                          </>
                        )}
                        {manageAction === 'accept' && (
                          <div>
                            <span
                              style={{
                                fontSize: 10,
                                color: 'var(--text-secondary)',
                                textTransform: 'uppercase',
                                letterSpacing: 1,
                                marginBottom: 4,
                                display: 'block',
                              }}
                            >
                              Budget (USDC)
                            </span>
                            <input
                              style={S.input}
                              value={amountUSDC}
                              onChange={(e) => setAmountUSDC(e.target.value)}
                              placeholder="e.g. 1.000000"
                            />
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 10 }}>
                              You (the provider) set your price here. It is signed from your
                              provider wallet by the existing accept route — the client then
                              funds escrow.
                            </span>
                          </div>
                        )}
                        {manageError && (
                          <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 8px' }}>
                            ❌ {manageError}
                          </p>
                        )}
                        <button
                          style={{ ...S.btn(manageLoading) }}
                          disabled={manageLoading}
                          onClick={runManageAction}
                        >
                          {manageLoading ? 'Sending to Arc...' : `Execute: ${manageAction === 'accept' ? 'Accept / Set Budget' : manageAction}`}
                        </button>
                      </div>
                    )}

                    {manageResult && (
                      <div
                        style={{
                          marginTop: 12,
                          background: 'rgba(6,182,212,0.06)',
                          border: '1px solid rgba(6,182,212,0.2)',
                          borderRadius: 10,
                          padding: 14,
                        }}
                      >
                        <p
                          style={{
                            color: '#06b6d4',
                            fontWeight: 700,
                            fontSize: 13,
                            margin: '0 0 6px',
                          }}
                        >
                          ✅ {manageResult.message}
                        </p>
                        {manageResult.explorerUrl && (
                          <a
                            href={manageResult.explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--primary)', fontSize: 11, fontFamily: 'monospace' }}
                          >
                            View on ArcScan →
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
