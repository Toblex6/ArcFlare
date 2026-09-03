//src/app/agents/page.tsx
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
  { label: 'Agents', href: '/agents', active: true },
  { label: 'Jobs', href: '/jobs' },
  { label: 'Support', href: '/support' },
];

interface Agent {
  id: number;
  name: string;
  tokenId: string;
  scaAddress: string;
  circleWalletId: string | null;
  status: string;
  createdAt: string;
  totalPaid?: number;
  paymentCount?: number;
}

interface ReputationResult {
  success: boolean;
  agentId: string;
  score: number;
  tag: string;
  txHash: string;
  explorerUrl: string;
  message: string;
}

interface RepValidatorOption {
  validatorSCA: string;
  circleWalletId: string;
  label: string;
}

interface ValidationResult {
  success: boolean;
  action: string;
  requestHash?: string;
  passed?: boolean;
  txHash: string;
  explorerUrl: string;
  nextStep?: string;
  message: string;
}

export default function AgentsPage() {
  const _router = useRouter();
  React.useEffect(() => {
    fetch('/api/merchant/me').then((r) => {
      if (r.status === 401) _router.replace('/merchant/login');
    }).catch(() => _router.replace('/merchant/login'));
  }, []);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState<'registry' | 'reputation' | 'validation' | 'deploy' | 'economics' | 'trust'>(
    'registry'
  );
  const [ecoAgentId, setEcoAgentId] = useState('');
  const [ecoData, setEcoData] = useState<any>(null);
  const [ecoLoading, setEcoLoading] = useState(false);
  const [ecoError, setEcoError] = useState<string|null>(null);
  const [trustId, setTrustId] = useState('');
  const [trustData, setTrustData] = useState<any>(null);
  const [trustLoading, setTrustLoading] = useState(false);
  const [trustError, setTrustError] = useState<string|null>(null);

  // Economics / Trust loaders — accept any agent identifier (Registry ID,
  // ERC-8004 Token, or SCA address); the backend resolves all three.
  const loadEco = async (agentIdRef: string) => {
    setEcoLoading(true); setEcoError(null);
    try{ const r=await fetch(`/api/agents/${agentIdRef}/ledger`); const d=await r.json(); if(!r.ok) throw new Error(d.error||'failed'); setEcoData(d); }catch(e:any){ setEcoError(e.message);} finally{ setEcoLoading(false); }
  };
  const loadTrust = async (agentIdRef: string) => {
    setTrustLoading(true); setTrustError(null);
    try{ const r=await fetch(`/api/agents/${agentIdRef}/track-record`); const d=await r.json(); if(!r.ok) throw new Error(d.error||'failed'); setTrustData(d.trackRecord); }catch(e:any){ setTrustError(e.message);} finally{ setTrustLoading(false); }
  };


  // Deploy state
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployName, setDeployName] = useState('ArcFlare Autonomous Agent');

  // Reputation state
  const [repAgentId, setRepAgentId] = useState('');
  const [repValidatorSCA, setRepValidatorSCA] = useState('');
  const [repScore, setRepScore] = useState('95');
  const [repTag, setRepTag] = useState('successful_payment');
  const [repLoading, setRepLoading] = useState(false);
  const [repResult, setRepResult] = useState<ReputationResult | null>(null);
  const [repError, setRepError] = useState<string | null>(null);
  const [repValidatorOptions, setRepValidatorOptions] = useState<RepValidatorOption[]>([]);
  const [merchantWallet, setMerchantWallet] = useState<{ walletAddress: string | null; circleWalletId: string | null } | null>(null);
  const [repWalletLoaded, setRepWalletLoaded] = useState(false);

  // Validation state
  const [valTab, setValTab] = useState<'request' | 'respond' | 'status'>('request');
  const [valAgentId, setValAgentId] = useState('');
  const [valOwnerSCA, setValOwnerSCA] = useState('');
  const [valValidatorSCA, setValValidatorSCA] = useState('');
  const [valTag, setValTag] = useState('kyc_verification');
  const [valRequestHash, setValRequestHash] = useState('');
  const [valPassed, setValPassed] = useState(true);
  const [valLoading, setValLoading] = useState(false);
  const [valResult, setValResult] = useState<ValidationResult | null>(null);
  const [valError, setValError] = useState<string | null>(null);

  // Load agents — the full registry list for this merchant. The old load
  // path (/api/agent/status?name=Agent) silently hid any agent whose name
  // didn't contain "Agent".
  useEffect(() => {
    fetch('/api/agent/list')
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setAgents(d.agents || []);
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/merchant/wallet')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.wallet) {
          setMerchantWallet({
            walletAddress: d.wallet.walletAddress || null,
            circleWalletId: d.wallet.circleWalletId || null,
          });
        }
      })
      .catch(() => { })
      .finally(() => { if (!cancelled) setRepWalletLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const buildOptions = (): RepValidatorOption[] => {
      const options: RepValidatorOption[] = [];
      if (merchantWallet?.walletAddress && merchantWallet?.circleWalletId) {
        options.push({
          validatorSCA: merchantWallet.walletAddress,
          circleWalletId: merchantWallet.circleWalletId,
          label: 'Merchant wallet',
        });
      }
      for (const a of agents) {
        if (a.scaAddress && a.circleWalletId && String(a.tokenId) !== String(repAgentId || '')) {
          options.push({
            validatorSCA: a.scaAddress,
            circleWalletId: a.circleWalletId,
            label: `${a.name} · Token #${a.tokenId}`,
          });
        }
      }
      return options;
    };
    const next = buildOptions();
    setRepValidatorOptions(next);
    setRepValidatorSCA((current) => {
      const stillEligible = next.some(
        (o) => o.validatorSCA.toLowerCase() === (current || '').trim().toLowerCase()
      );
      return stillEligible ? current : (next[0]?.validatorSCA || '');
    });
  }, [agents, merchantWallet, repAgentId]);

  const deployAgent = async () => {
    setDeploying(true);
    setDeployError(null);
    setDeployResult(null);
    try {
      const res = await fetch('/api/agent/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: deployName,
          metadataUri: 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei',
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // Success is locked in BEFORE the list refresh — the refresh used to
      // run inside the same try block, so a failure there (the list route
      // 404ing, pre-fix) showed a JSON.parse error banner next to the
      // success one.
      setDeployResult(data);
    } catch (e: any) {
      setDeployError(e.message);
      setDeploying(false);
      return;
    }
    setDeploying(false);
    // List refresh is best-effort and can't taint the deploy result. The
    // /api/agent/list route now exists — this previously hit a 404 HTML page
    // and crashed JSON.parse.
    try {
      const listRes = await fetch('/api/agent/list');
      const d2 = await listRes.json();
      if (d2.success) setAgents(d2.agents || []);
    } catch {
      // Non-fatal: the deployed agent still shows in the success panel.
    }
  };

  const submitReputation = async () => {
    setRepLoading(true);
    setRepError(null);
    setRepResult(null);
    try {
      const selected = repValidatorOptions.find(
        (o) => o.validatorSCA.toLowerCase() === (repValidatorSCA || '').trim().toLowerCase()
      );
      if (!selected) {
        throw new Error('No eligible validator wallet selected. Add a merchant Circle wallet or deploy an agent first.');
      }
      const body: any = {
        agentId: repAgentId,
        validatorSCA: selected.validatorSCA,
        validatorWalletId: selected.circleWalletId,
        score: parseInt(repScore),
        tag: repTag,
        feedbackType: 0,
      };
      const res = await fetch('/api/agent/reputation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setRepResult(data);
    } catch (e: any) {
      setRepError(e.message);
    } finally {
      setRepLoading(false);
    }
  };

  const submitValidation = async () => {
    setValLoading(true);
    setValError(null);
    setValResult(null);
    try {
      let body: any = {};
      if (valTab === 'request') {
        body = {
          action: 'request',
          agentId: valAgentId,
          ownerSCA: valOwnerSCA,
          validatorSCA: valValidatorSCA,
          requestTag: valTag,
        };
      } else if (valTab === 'respond') {
        body = {
          action: 'respond',
          validatorSCA: valValidatorSCA,
          requestHash: valRequestHash,
          passed: valPassed,
          tag: valTag,
        };
      } else {
        // status — use GET
        const res = await fetch(`/api/agent/validation?requestHash=${valRequestHash}`, {
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setValResult({
          ...data.validation,
          success: true,
          action: 'status',
          txHash: '',
          explorerUrl: '',
          message: data.message,
        });
        setValLoading(false);
        return;
      }
      const res = await fetch('/api/agent/validation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setValResult(data);
    } catch (e: any) {
      setValError(e.message);
    } finally {
      setValLoading(false);
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
    btn: {
      padding: '12px 24px',
      background: 'var(--primary)',
      color: 'var(--background)',
      border: 'none',
      borderRadius: 10,
      fontWeight: 700,
      fontSize: 13,
      cursor: 'pointer',
    },
    btnGhost: {
      padding: '10px 20px',
      background: 'transparent',
      color: 'var(--primary)',
      border: '1px solid var(--primary)',
      borderRadius: 10,
      fontWeight: 600,
      fontSize: 12,
      cursor: 'pointer',
    },
    label: {
      fontSize: 10,
      color: 'var(--text-secondary)',
      textTransform: 'uppercase' as const,
      letterSpacing: 1,
      marginBottom: 4,
      display: 'block' as const,
    },
    badge: (color: string) => ({
      fontSize: 10,
      padding: '2px 8px',
      borderRadius: 10,
      background: `${color}20`,
      border: `1px solid ${color}40`,
      color,
      fontFamily: 'monospace',
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
  };

  return (
    <div className="light" style={S.page}>
      {/* Sidebar */}
      <DashboardSidebar active="Agents" />

      {/* Main */}
      <main style={S.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
            Agent Hub
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            ERC-8004 agent identity, reputation and validation on Arc Testnet
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' as const }}>
          {(['registry', 'reputation', 'validation', 'deploy', 'economics', 'trust'] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === 'registry'
                ? '🤖 Agent Registry'
                : t === 'reputation'
                  ? '⭐ Reputation'
                  : t === 'validation'
                    ? '✅ Validation'
                    : t === 'economics'
                      ? '💰 Economics'
                      : t === 'trust'
                        ? '🏆 Trust'
                        : '⚡ Deploy Agent'}
            </button>
          ))}
        </div>

        {/* ── REGISTRY TAB ── */}
        {activeTab === 'registry' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 16px' }}>
              Registered Agents
            </h3>
            {loading ? (
              <p style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: 12 }}>
                Loading agents...
              </p>
            ) : agents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <p style={{ fontSize: 32, marginBottom: 8 }}>🤖</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>No agents deployed yet.</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 }}>
                  Use the Deploy Agent tab to create your first ERC-8004 agent.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    onClick={() => setSelected(selected?.id === agent.id ? null : agent)}
                    style={{
                      background: 'var(--surface-secondary)',
                      border: `1px solid ${selected?.id === agent.id ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius: 14,
                      padding: 18,
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            background: 'rgba(200,151,90,0.15)',
                            border: '1px solid rgba(200,151,90,0.3)',
                            borderRadius: 9,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 16,
                          }}
                        >
                          🤖
                        </div>
                        <div>
                          <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 13, margin: 0 }}>
                            {agent.name}
                          </p>
                          <p
                            style={{
                              color: 'var(--text-secondary)',
                              fontSize: 10,
                              margin: 0,
                              fontFamily: 'monospace',
                            }}
                          >
                            Registry ID: {agent.id}
                          </p>
                          <p
                            style={{
                              color: 'var(--text-secondary)',
                              fontSize: 10,
                              margin: 0,
                              fontFamily: 'monospace',
                            }}
                          >
                            ERC-8004 Token: #{agent.tokenId}
                          </p>
                        </div>
                      </div>
                      <span
                        style={S.badge(
                          agent.status === 'ACTIVE_AGENT_PROVISIONED' ? 'var(--success)' : 'var(--text-secondary)'
                        )}
                      >
                        {agent.status === 'ACTIVE_AGENT_PROVISIONED' ? 'ACTIVE' : agent.status}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div style={{ background: 'var(--surface)', borderRadius: 8, padding: 10 }}>
                        <span style={S.label}>SCA Wallet</span>
                        <p
                          style={{
                            color: 'var(--primary)',
                            fontFamily: 'monospace',
                            fontSize: 11,
                            margin: 0,
                            wordBreak: 'break-all',
                          }}
                        >
                          {agent.scaAddress}
                        </p>
                      </div>
                      <div style={{ background: 'var(--surface)', borderRadius: 8, padding: 10 }}>
                        <span style={S.label}>Circle Wallet ID</span>
                        <p
                          style={{
                            color: 'var(--text)',
                            fontFamily: 'monospace',
                            fontSize: 11,
                            margin: 0,
                          }}
                        >
                          {agent.circleWalletId || '—'}
                        </p>
                      </div>
                    </div>
                    {selected?.id === agent.id && (
                      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                        <button
                          style={S.btnGhost}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveTab('reputation');
                            setRepAgentId(agent.tokenId);
                          }}
                        >
                          Record Reputation
                        </button>
                        <button
                          style={S.btnGhost}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveTab('validation');
                            setValAgentId(agent.tokenId);
                            setValOwnerSCA(agent.scaAddress);
                          }}
                        >
                          Request Validation
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── REPUTATION TAB ── */}
        {activeTab === 'reputation' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
              Record Agent Reputation
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 20px' }}>
              Per ERC-8004 — the validator wallet must be different from the agent owner wallet.
            </p>
            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}
            >
              <div>
                <span style={S.label}>Agent Token ID</span>
                <input
                  style={S.input}
                  value={repAgentId}
                  onChange={(e) => setRepAgentId(e.target.value)}
                  placeholder="e.g. 68210"
                />
              </div>
              <div>
                <span style={S.label}>Validator SCA (signing wallet)</span>
                {loading || !repWalletLoaded ? (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                    Resolving your signing wallet…
                  </p>
                ) : repValidatorOptions.length === 0 ? (
                  <div
                    style={{
                      background: 'rgba(239,68,68,0.08)',
                      border: '1px solid rgba(239,68,68,0.2)',
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 10,
                    }}
                  >
                    <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>
                      No eligible validator wallet found — add a Circle wallet to your merchant account or deploy an agent before recording reputation.
                    </p>
                  </div>
                ) : repValidatorOptions.length === 1 ? (
                  <input
                    style={S.input}
                    value={repValidatorSCA || repValidatorOptions[0].validatorSCA}
                    readOnly
                    aria-label="Validator SCA (signing wallet)"
                  />
                ) : (
                  <select
                    style={S.input}
                    value={repValidatorSCA}
                    onChange={(e) => setRepValidatorSCA(e.target.value)}
                    aria-label="Validator SCA (signing wallet)"
                  >
                    {repValidatorOptions.map((o) => (
                      <option key={o.validatorSCA} value={o.validatorSCA}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                <p style={{ color: 'var(--text-secondary)', fontSize: 11, margin: '0 0 10px', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {repValidatorSCA || repValidatorOptions[0]?.validatorSCA || '—'}
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
                  This reputation will be signed by your wallet.
                </p>
              </div>
              <div>
                <span style={S.label}>Score (0-100)</span>
                <input
                  style={S.input}
                  type="number"
                  min="0"
                  max="100"
                  value={repScore}
                  onChange={(e) => setRepScore(e.target.value)}
                  placeholder="95"
                />
              </div>
              <div>
                <span style={S.label}>Tag</span>
                <input
                  style={S.input}
                  value={repTag}
                  onChange={(e) => setRepTag(e.target.value)}
                  placeholder="successful_payment"
                />
              </div>
            </div>
            <button
              style={{ ...S.btn, opacity: repLoading ? 0.6 : 1 }}
              disabled={repLoading || loading || !repWalletLoaded || repValidatorOptions.length === 0}
              onClick={submitReputation}
            >
              {repLoading ? 'Submitting to Arc...' : '⭐ Record Reputation Onchain'}
            </button>
            {repError && (
              <div
                style={{
                  marginTop: 12,
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>❌ {repError}</p>
              </div>
            )}
            {repResult && (
              <div
                style={{
                  marginTop: 12,
                  background: 'rgba(6,182,212,0.06)',
                  border: '1px solid rgba(6,182,212,0.2)',
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <p style={{ color: 'var(--success)', fontWeight: 700, fontSize: 13, margin: '0 0 8px' }}>
                  ✅ Reputation recorded onchain
                </p>
                <p style={{ color: 'var(--text)', fontSize: 12, margin: '0 0 4px' }}>
                  Score: <strong style={{ color: 'var(--primary)' }}>{repResult.score}/100</strong> — Tag:{' '}
                  {repResult.tag}
                </p>
                <a
                  href={repResult.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', fontSize: 11, fontFamily: 'monospace' }}
                >
                  View on ArcScan →
                </a>
              </div>
            )}
          </div>
        )}

        {/* ── VALIDATION TAB ── */}
        {activeTab === 'validation' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
              ERC-8004 Validation
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 16px' }}>
              Two-step flow: owner requests → validator responds.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {(['request', 'respond', 'status'] as const).map((t) => (
                <button key={t} style={S.tab(valTab === t)} onClick={() => setValTab(t)}>
                  {t === 'request'
                    ? '1. Request'
                    : t === 'respond'
                      ? '2. Respond'
                      : '3. Check Status'}
                </button>
              ))}
            </div>

            {valTab === 'request' && (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 12,
                    marginBottom: 12,
                  }}
                >
                  <div>
                    <span style={S.label}>Agent Token ID</span>
                    <input
                      style={S.input}
                      value={valAgentId}
                      onChange={(e) => setValAgentId(e.target.value)}
                      placeholder="68210"
                    />
                  </div>
                  <div>
                    <span style={S.label}>Owner SCA (you)</span>
                    <input
                      style={S.input}
                      value={valOwnerSCA}
                      onChange={(e) => setValOwnerSCA(e.target.value)}
                      placeholder="0xOwnerAddress"
                    />
                  </div>
                  <div>
                    <span style={S.label}>Validator SCA</span>
                    <input
                      style={S.input}
                      value={valValidatorSCA}
                      onChange={(e) => setValValidatorSCA(e.target.value)}
                      placeholder="0xValidatorAddress"
                    />
                  </div>
                  <div>
                    <span style={S.label}>Validation Tag</span>
                    <input
                      style={S.input}
                      value={valTag}
                      onChange={(e) => setValTag(e.target.value)}
                      placeholder="kyc_verification"
                    />
                  </div>
                </div>
                <button
                  style={{ ...S.btn, opacity: valLoading ? 0.6 : 1 }}
                  disabled={valLoading}
                  onClick={submitValidation}
                >
                  {valLoading ? 'Submitting...' : 'Request Validation Onchain'}
                </button>
              </>
            )}

            {valTab === 'respond' && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <span style={S.label}>Request Hash (from step 1)</span>
                  <input
                    style={S.input}
                    value={valRequestHash}
                    onChange={(e) => setValRequestHash(e.target.value)}
                    placeholder="0x..."
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <span style={S.label}>Validator SCA</span>
                  <input
                    style={S.input}
                    value={valValidatorSCA}
                    onChange={(e) => setValValidatorSCA(e.target.value)}
                    placeholder="0xValidatorAddress"
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <span style={S.label}>Response Tag</span>
                  <input
                    style={S.input}
                    value={valTag}
                    onChange={(e) => setValTag(e.target.value)}
                    placeholder="kyc_verified"
                  />
                </div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  <button
                    style={{
                      ...S.tab(valPassed),
                      borderColor: 'var(--success)',
                      color: valPassed ? 'var(--success)' : 'var(--text-secondary)',
                    }}
                    onClick={() => setValPassed(true)}
                  >
                    ✅ Passed (100)
                  </button>
                  <button
                    style={{
                      ...S.tab(!valPassed),
                      borderColor: 'var(--danger)',
                      color: !valPassed ? 'var(--danger)' : 'var(--text-secondary)',
                    }}
                    onClick={() => setValPassed(false)}
                  >
                    ❌ Failed (0)
                  </button>
                </div>
                <button
                  style={{ ...S.btn, opacity: valLoading ? 0.6 : 1 }}
                  disabled={valLoading}
                  onClick={submitValidation}
                >
                  {valLoading ? 'Submitting...' : 'Submit Validation Response'}
                </button>
              </>
            )}

            {valTab === 'status' && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <span style={S.label}>Request Hash</span>
                  <input
                    style={S.input}
                    value={valRequestHash}
                    onChange={(e) => setValRequestHash(e.target.value)}
                    placeholder="0x..."
                  />
                </div>
                <button
                  style={{ ...S.btn, opacity: valLoading ? 0.6 : 1 }}
                  disabled={valLoading}
                  onClick={submitValidation}
                >
                  {valLoading ? 'Checking...' : 'Check Validation Status'}
                </button>
              </>
            )}

            {valError && (
              <div
                style={{
                  marginTop: 12,
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>❌ {valError}</p>
              </div>
            )}
            {valResult && (
              <div
                style={{
                  marginTop: 12,
                  background: 'rgba(6,182,212,0.06)',
                  border: '1px solid rgba(6,182,212,0.2)',
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <p style={{ color: 'var(--success)', fontWeight: 700, fontSize: 13, margin: '0 0 8px' }}>
                  ✅ {valResult.message}
                </p>
                {valResult.requestHash && (
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: 11,
                      fontFamily: 'monospace',
                      margin: '0 0 4px',
                    }}
                  >
                    Request Hash: {valResult.requestHash}
                  </p>
                )}
                {valResult.nextStep && (
                  <p style={{ color: 'var(--primary)', fontSize: 11, margin: '0 0 8px' }}>
                    Next: {valResult.nextStep}
                  </p>
                )}
                {valResult.explorerUrl && (
                  <a
                    href={valResult.explorerUrl}
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

        {/* ── ECONOMICS TAB ── */}
        {activeTab === 'economics' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 4px' }}>Agent Economics</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 16px' }}>Treasury, P&L and recent ledger entries (derived from on-chain events).</p>
            <div style={{ marginBottom: 12 }}>
              <select
                style={S.input}
                value={ecoAgentId}
                onChange={(e) => {
                  const a = agents.find((x) => String(x.id) === e.target.value);
                  if (!a) return;
                  setEcoAgentId(String(a.id));
                  loadEco(String(a.id));
                }}
              >
                <option value="">— Select an agent —</option>
                {agents.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name} — Registry ID {a.id} · Token #{a.tokenId}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input style={{ ...S.input, marginBottom: 0, flex: 1 }} value={ecoAgentId} onChange={e=>setEcoAgentId(e.target.value)} placeholder="Registry ID, ERC-8004 Token, or SCA address" />
              <button style={S.btn} disabled={ecoLoading} onClick={()=>loadEco(ecoAgentId)}>{ecoLoading?'Loading...':'Load'}</button>
            </div>
            {ecoError && <p style={{ color:'var(--danger)', fontSize:12 }}>❌ {ecoError}</p>}
            {ecoData && (
              <div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:12 }}>
                  {[
                    ['Treasury', (Number(ecoData.treasury.treasuryBalance)/1e6).toFixed(6)+' USDC'],
                    ['Available', (Number(ecoData.treasury.availableBalance)/1e6).toFixed(6)+' USDC'],
                    ['Locked', (Number(ecoData.treasury.escrowLocked)/1e6).toFixed(6)+' USDC'],
                    ['Revenue', (Number(ecoData.treasury.revenue)/1e6).toFixed(6)],
                    ['Costs', (Number(ecoData.treasury.costs)/1e6).toFixed(6)],
                    ['Profit', (Number(ecoData.treasury.profit)/1e6).toFixed(6)],
                    ['Reinvest Reserved', (Number(ecoData.treasury.reinvestReserved)/1e6).toFixed(6)],
                    ['Pending Income', (Number(ecoData.treasury.pendingIncome)/1e6).toFixed(6)],
                    ['Entries', String(ecoData.treasury.entryCount)],
                  ].map(([k,v])=>(
                    <div key={k} style={{ background:'var(--surface-secondary)', borderRadius:8, padding:10 }}>
                      <span style={S.label}>{k}</span>
                      <p style={{ margin:0, fontSize:13, fontWeight:700 }}>{v}</p>
                    </div>
                  ))}
                </div>
                {ecoData.policy && (
                  <div style={{ background:'var(--surface-secondary)', borderRadius:8, padding:10, marginBottom:12 }}>
                    <span style={S.label}>Treasury Policy</span>
                    <pre style={{ fontSize:11, margin:'6px 0 0', whiteSpace:'pre-wrap' }}>{JSON.stringify(ecoData.policy,null,2)}</pre>
                  </div>
                )}
                <span style={S.label}>Recent entries</span>
                <div style={{ display:'flex', flexDirection:'column' as const, gap:6, marginTop:6 }}>
                  {(ecoData.recent||[]).map((e:any)=>(
                    <div key={e.id} style={{ background:'var(--surface-secondary)', borderRadius:8, padding:8, fontSize:11, fontFamily:'monospace' }}>
                      [{e.type}] {e.direction} {(Number(e.amount)/1e6).toFixed(6)} · {e.txHash?e.txHash.slice(0,14)+'…':e.dedupeKey} {e.jobValidationId?' · validation-linked':''}
                    </div>
                  ))}
                  {(!ecoData.recent||ecoData.recent.length===0) && <p style={{ fontSize:12, color:'var(--text-secondary)' }}>No ledger entries yet.</p>}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'trust' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 4px' }}>Verifiable Track Record</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 16px' }}>Every trust number has an underlying source (jobs, validation, ledger, reputation). Score 0..100 · confidence 0..100 · methodology 1.0</p>
            <div style={{ marginBottom: 12 }}>
              <select
                style={S.input}
                value={trustId}
                onChange={(e) => {
                  const a = agents.find((x) => String(x.id) === e.target.value);
                  if (!a) return;
                  setTrustId(String(a.id));
                  loadTrust(String(a.id));
                }}
              >
                <option value="">— Select an agent —</option>
                {agents.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name} — Registry ID {a.id} · Token #{a.tokenId}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input style={{ ...S.input, marginBottom: 0, flex: 1 }} value={trustId} onChange={e=>setTrustId(e.target.value)} placeholder="Registry ID, ERC-8004 Token, or SCA address" />
              <button style={S.btn} disabled={trustLoading} onClick={()=>loadTrust(trustId)}>{trustLoading?'Loading...':'Load'}</button>
            </div>
            {trustError && <p style={{ color:'var(--danger)', fontSize:12 }}>❌ {trustError}</p>}
            {trustData && (
              <div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:10, marginBottom:12 }}>
                  {[
                    ['Trust', String(trustData.trust.score)],
                    ['Confidence', String(trustData.trust.confidence)],
                    ['Completed', String(trustData.stats.completedJobs)],
                    ['Validated', String(trustData.stats.validatedJobs)],
                    ['Pass Rate', trustData.stats.validationPassRate!==null?`${Math.round(trustData.stats.validationPassRate*100)}%`:'—'],
                    ['Validated Volume', trustData.stats.validatedVolumeUSDC+' USDC'],
                    ['Unique Validators', String(trustData.stats.uniqueValidators)],
                    ['Method', trustData.trust.methodologyVersion],
                  ].map(([k,v]: any)=>(
                    <div key={k} style={{ background:'var(--surface-secondary)', borderRadius:8, padding:10 }}>
                      <span style={S.label}>{k}</span>
                      <p style={{ margin:0, fontSize:13, fontWeight:700 }}>{v}</p>
                    </div>
                  ))}
                </div>
                <div style={{ background:'var(--surface-secondary)', borderRadius:8, padding:10, marginBottom:12 }}>
                  <span style={S.label}>Breakdown (job/validation/reputation/payment/economic)</span>
                  <pre style={{ fontSize:11, margin:'6px 0 0', whiteSpace:'pre-wrap' }}>{JSON.stringify(trustData.trust.breakdown,null,2)}</pre>
                </div>
                <span style={S.label}>Recent verified work</span>
                <div style={{ display:'flex', flexDirection:'column' as const, gap:6, marginTop:6 }}>
                  {(trustData.recentOutcomes||[]).map((o:any)=>(
                    <div key={o.jobId} style={{ background:'var(--surface-secondary)', borderRadius:8, padding:8, fontSize:11, fontFamily:'monospace' }}>
                      Job {o.jobId} · {o.status} · {(Number(o.budget)/1e6).toFixed(2)} USDC {o.validation?`· validation ${o.validation.status}`:''} {o.txHash?'· '+o.txHash.slice(0,14)+'…':''}
                    </div>
                  ))}
                  {(!trustData.recentOutcomes||trustData.recentOutcomes.length===0) && <p style={{ fontSize:12, color:'var(--text-secondary)' }}>No verified work yet — fresh agent (score 50, low confidence is expected).</p>}
                </div>
                <div style={{ background:'var(--surface-secondary)', borderRadius:8, padding:10, marginTop:12 }}>
                  <span style={S.label}>Evidence References</span>
                  <pre style={{ fontSize:11, margin:'6px 0 0', whiteSpace:'pre-wrap', wordBreak:'break-all' as const }}>{JSON.stringify(trustData.evidenceReferences,null,2)}</pre>
                </div>
                <p style={{ fontSize:11, color:'var(--text-secondary)', marginTop:8 }}>Reputation registry: {trustData.reputation.registryAddress} · readOk={String(trustData.reputation.readOk)} · onChainScore={String(trustData.reputation.reputationScore)}</p>
              </div>
            )}
          </div>
        )}

        {/* ── DEPLOY TAB ── */}
        {activeTab === 'deploy' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
              Deploy New ERC-8004 Agent
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 20px' }}>
              Creates a Circle SCA wallet and registers an ERC-8004 identity on Arc Testnet.
            </p>
            <span style={S.label}>Agent Name</span>
            <input
              style={S.input}
              value={deployName}
              onChange={(e) => setDeployName(e.target.value)}
              placeholder="My Autonomous Agent"
            />
            <button
              style={{ ...S.btn, opacity: deploying ? 0.6 : 1 }}
              disabled={deploying}
              onClick={deployAgent}
            >
              {deploying ? 'Deploying to Arc Testnet...' : '⚡ Deploy Agent'}
            </button>
            {deployError && (
              <div
                style={{
                  marginTop: 12,
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>❌ {deployError}</p>
              </div>
            )}
            {deployResult && (
              <div
                style={{
                  marginTop: 16,
                  background: 'rgba(200,151,90,0.06)',
                  border: '1px solid rgba(200,151,90,0.2)',
                  borderRadius: 14,
                  padding: 20,
                }}
              >
                <p style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 14, margin: '0 0 14px' }}>
                  ✅ Agent Deployed Successfully
                </p>
                {[
                  { label: 'Agent Name', value: deployResult.agent?.name },
                  { label: 'Token ID', value: `#${deployResult.agent?.tokenId}` },
                  { label: 'SCA Address', value: deployResult.agent?.scaAddress },
                  { label: 'Circle Wallet ID', value: deployResult.agent?.circleWalletId },
                  { label: 'Status', value: deployResult.agent?.status },
                ].map((row) => (
                  <div
                    key={row.label}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '6px 0',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{row.label}</span>
                    <span style={{ color: 'var(--text)', fontSize: 11, fontFamily: 'monospace' }}>
                      {row.value}
                    </span>
                  </div>
                ))}
                {deployResult.explorerUrl && (
                  <a
                    href={deployResult.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'block',
                      marginTop: 14,
                      textAlign: 'center',
                      padding: '10px',
                      background: 'rgba(200,151,90,0.1)',
                      border: '1px solid rgba(200,151,90,0.25)',
                      borderRadius: 8,
                      color: 'var(--primary)',
                      fontSize: 12,
                      textDecoration: 'none',
                      fontWeight: 600,
                    }}
                  >
                    View on ArcScan →
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
