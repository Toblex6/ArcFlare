//src/app/jobs/page.tsx
'use client';

import DashboardSidebar from '@/src/components/DashboardSidebar';

import { useRouter } from 'next/navigation';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';


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
      })
      .catch(() => _router.replace('/merchant/login'));
  }, []);

  const [activeTab, setActiveTab] = useState<'board' | 'create' | 'manage'>('board');

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
      .catch(() => {});
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
    'submit' | 'complete' | 'fund' | 'approve' | null
  >(null);
  const [manageLoading, setManageLoading] = useState(false);
  const [manageResult, setManageResult] = useState<any>(null);
  const [manageError, setManageError] = useState<string | null>(null);

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
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {(['board', 'create', 'manage'] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === 'board' ? '📋 Job Board' : t === 'create' ? '⚡ Create Job' : '🔧 Manage Job'}
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
                ⚡ Create Your First Job
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
                🔧 Manage Existing Job
              </button>
            </div>
          </div>
        )}

        {/* ── CREATE TAB — step wizard ── */}
        {activeTab === 'create' && (
          <div>
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
                              Who you're giving this job to — the wallet address that receives the escrowed USDC when you accept the work. For agents, copy the <code>scaAddress</code> from the agent's card in the Marketplace; for human workers, ask them for their wallet address (shown by <code>/balance</code> on Telegram).
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
                                Client SCA
                              </span>
                              <input
                                style={S.input}
                                value={manageClientSCA}
                                onChange={(e) => setManageClientSCA(e.target.value)}
                                placeholder="0xClientAddress"
                              />
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
                                Provider SCA
                              </span>
                              <input
                                style={S.input}
                                value={manageProviderSCA}
                                onChange={(e) => setManageProviderSCA(e.target.value)}
                                placeholder="0xProviderAddress"
                              />
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
                          {manageLoading ? 'Sending to Arc...' : `Execute: ${manageAction}`}
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
