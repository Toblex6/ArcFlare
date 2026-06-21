'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || '';

const NAV = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Homepage', href: '/' },
  { label: 'Transactions', href: '/transactions' },
  { label: 'Checkout', href: '/checkout' },
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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState<'registry' | 'reputation' | 'validation' | 'deploy'>(
    'registry'
  );

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

  // Load agents
  useEffect(() => {
    fetch('/api/agent/status?name=Agent', {
      headers: { 'x-api-key': API_KEY },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setAgents(d.agents || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const deployAgent = async () => {
    setDeploying(true);
    setDeployError(null);
    setDeployResult(null);
    try {
      const res = await fetch('/api/agent/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          agentName: deployName,
          metadataUri: 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei',
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setDeployResult(data);
      // Refresh agent list
      const r2 = await fetch('/api/agent/status?name=Agent', { headers: { 'x-api-key': API_KEY } });
      const d2 = await r2.json();
      if (d2.success) setAgents(d2.agents || []);
    } catch (e: any) {
      setDeployError(e.message);
    } finally {
      setDeploying(false);
    }
  };

  const submitReputation = async () => {
    setRepLoading(true);
    setRepError(null);
    setRepResult(null);
    try {
      const res = await fetch('/api/agent/reputation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          agentId: repAgentId,
          validatorSCA: repValidatorSCA,
          score: parseInt(repScore),
          tag: repTag,
          feedbackType: 0,
        }),
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
          headers: { 'x-api-key': API_KEY },
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
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
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
      background: '#0e0b08',
      fontFamily: 'Inter, system-ui, sans-serif',
      color: '#f0ece6',
    },
    aside: {
      width: 220,
      minHeight: '100vh',
      background: '#1a1410',
      display: 'flex',
      flexDirection: 'column' as const,
      padding: '24px 14px',
      flexShrink: 0,
      position: 'sticky' as const,
      top: 0,
      height: '100vh',
      overflowY: 'auto' as const,
      borderRight: '1px solid #2d2015',
    },
    main: { flex: 1, padding: '32px', overflowX: 'hidden' as const },
    card: {
      background: '#1a1410',
      border: '1px solid #2d2015',
      borderRadius: 16,
      padding: 24,
      marginBottom: 20,
    },
    input: {
      width: '100%',
      padding: '10px 14px',
      background: '#251c12',
      border: '1px solid #3d2e1a',
      borderRadius: 10,
      color: '#f0ece6',
      fontSize: 13,
      fontFamily: 'monospace',
      outline: 'none',
      boxSizing: 'border-box' as const,
      marginBottom: 10,
    },
    btn: {
      padding: '12px 24px',
      background: '#c8975a',
      color: '#0e0b08',
      border: 'none',
      borderRadius: 10,
      fontWeight: 700,
      fontSize: 13,
      cursor: 'pointer',
    },
    btnGhost: {
      padding: '10px 20px',
      background: 'transparent',
      color: '#c8975a',
      border: '1px solid #c8975a',
      borderRadius: 10,
      fontWeight: 600,
      fontSize: 12,
      cursor: 'pointer',
    },
    label: {
      fontSize: 10,
      color: '#6b5a45',
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
      border: `1px solid ${active ? '#c8975a' : '#2d2015'}`,
      background: active ? 'rgba(200,151,90,0.1)' : 'transparent',
      color: active ? '#c8975a' : '#6b5a45',
      fontWeight: active ? 700 : 400,
    }),
  };

  return (
    <div style={S.page}>
      {/* Sidebar */}
      <aside style={S.aside}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 36,
            paddingLeft: 6,
          }}
        >
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={36}
            height={36}
            style={{ borderRadius: 8, objectFit: 'contain' }}
          />
          <div>
            <p style={{ color: '#f0ece6', fontSize: 14, fontWeight: 700, margin: 0 }}>ArcFlare</p>
            <p style={{ color: '#6b5a45', fontSize: 9, margin: 0 }}>
              Stablecoin Payment Infrastructure
            </p>
          </div>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 9,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 500,
                background: (item as any).active ? 'rgba(200,151,90,0.15)' : 'transparent',
                color: (item as any).active ? '#c8975a' : '#6b5a45',
                border: (item as any).active
                  ? '1px solid rgba(200,151,90,0.25)'
                  : '1px solid transparent',
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div
          style={{
            marginTop: 12,
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.15)',
            borderRadius: 10,
            padding: '8px 12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#f59e0b',
                display: 'inline-block',
              }}
            />
            <span
              style={{
                fontSize: 9,
                color: '#f59e0b',
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              Arc Testnet Mode
            </span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main style={S.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>
            Agent Hub
          </h1>
          <p style={{ color: '#6b5a45', fontSize: 13, margin: 0 }}>
            ERC-8004 agent identity, reputation and validation on Arc Testnet
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {(['registry', 'reputation', 'validation', 'deploy'] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === 'registry'
                ? '🤖 Agent Registry'
                : t === 'reputation'
                  ? '⭐ Reputation'
                  : t === 'validation'
                    ? '✅ Validation'
                    : '⚡ Deploy Agent'}
            </button>
          ))}
        </div>

        {/* ── REGISTRY TAB ── */}
        {activeTab === 'registry' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 16px' }}>
              Registered Agents
            </h3>
            {loading ? (
              <p style={{ color: '#6b5a45', fontFamily: 'monospace', fontSize: 12 }}>
                Loading agents...
              </p>
            ) : agents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <p style={{ fontSize: 32, marginBottom: 8 }}>🤖</p>
                <p style={{ color: '#6b5a45', fontSize: 14 }}>No agents deployed yet.</p>
                <p style={{ color: '#4b4035', fontSize: 12, marginTop: 4 }}>
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
                      background: '#251c12',
                      border: `1px solid ${selected?.id === agent.id ? '#c8975a' : '#3d2e1a'}`,
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
                          <p style={{ color: '#f0ece6', fontWeight: 700, fontSize: 13, margin: 0 }}>
                            {agent.name}
                          </p>
                          <p
                            style={{
                              color: '#6b5a45',
                              fontSize: 10,
                              margin: 0,
                              fontFamily: 'monospace',
                            }}
                          >
                            Token #{agent.tokenId}
                          </p>
                        </div>
                      </div>
                      <span
                        style={S.badge(
                          agent.status === 'ACTIVE_AGENT_PROVISIONED' ? '#06b6d4' : '#6b5a45'
                        )}
                      >
                        {agent.status === 'ACTIVE_AGENT_PROVISIONED' ? 'ACTIVE' : agent.status}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div style={{ background: '#1a1410', borderRadius: 8, padding: 10 }}>
                        <span style={S.label}>SCA Address</span>
                        <p
                          style={{
                            color: '#c8975a',
                            fontFamily: 'monospace',
                            fontSize: 11,
                            margin: 0,
                            wordBreak: 'break-all',
                          }}
                        >
                          {agent.scaAddress}
                        </p>
                      </div>
                      <div style={{ background: '#1a1410', borderRadius: 8, padding: 10 }}>
                        <span style={S.label}>Circle Wallet ID</span>
                        <p
                          style={{
                            color: '#f0ece6',
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
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>
              Record Agent Reputation
            </h3>
            <p style={{ color: '#6b5a45', fontSize: 12, margin: '0 0 20px' }}>
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
                <span style={S.label}>Validator SCA Address</span>
                <input
                  style={S.input}
                  value={repValidatorSCA}
                  onChange={(e) => setRepValidatorSCA(e.target.value)}
                  placeholder="0x... (NOT the agent owner)"
                />
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
              disabled={repLoading}
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
                <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {repError}</p>
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
                <p style={{ color: '#06b6d4', fontWeight: 700, fontSize: 13, margin: '0 0 8px' }}>
                  ✅ Reputation recorded onchain
                </p>
                <p style={{ color: '#f0ece6', fontSize: 12, margin: '0 0 4px' }}>
                  Score: <strong style={{ color: '#c8975a' }}>{repResult.score}/100</strong> — Tag:{' '}
                  {repResult.tag}
                </p>
                <a
                  href={repResult.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#c8975a', fontSize: 11, fontFamily: 'monospace' }}
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
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>
              ERC-8004 Validation
            </h3>
            <p style={{ color: '#6b5a45', fontSize: 12, margin: '0 0 16px' }}>
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
                      borderColor: '#06b6d4',
                      color: valPassed ? '#06b6d4' : '#6b5a45',
                    }}
                    onClick={() => setValPassed(true)}
                  >
                    ✅ Passed (100)
                  </button>
                  <button
                    style={{
                      ...S.tab(!valPassed),
                      borderColor: '#f87171',
                      color: !valPassed ? '#f87171' : '#6b5a45',
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
                <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {valError}</p>
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
                <p style={{ color: '#06b6d4', fontWeight: 700, fontSize: 13, margin: '0 0 8px' }}>
                  ✅ {valResult.message}
                </p>
                {valResult.requestHash && (
                  <p
                    style={{
                      color: '#6b5a45',
                      fontSize: 11,
                      fontFamily: 'monospace',
                      margin: '0 0 4px',
                    }}
                  >
                    Request Hash: {valResult.requestHash}
                  </p>
                )}
                {valResult.nextStep && (
                  <p style={{ color: '#c8975a', fontSize: 11, margin: '0 0 8px' }}>
                    Next: {valResult.nextStep}
                  </p>
                )}
                {valResult.explorerUrl && (
                  <a
                    href={valResult.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#c8975a', fontSize: 11, fontFamily: 'monospace' }}
                  >
                    View on ArcScan →
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── DEPLOY TAB ── */}
        {activeTab === 'deploy' && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 4px' }}>
              Deploy New ERC-8004 Agent
            </h3>
            <p style={{ color: '#6b5a45', fontSize: 12, margin: '0 0 20px' }}>
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
                <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {deployError}</p>
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
                <p style={{ color: '#c8975a', fontWeight: 700, fontSize: 14, margin: '0 0 14px' }}>
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
                      borderBottom: '1px solid #2d2015',
                    }}
                  >
                    <span style={{ color: '#6b5a45', fontSize: 12 }}>{row.label}</span>
                    <span style={{ color: '#f0ece6', fontSize: 11, fontFamily: 'monospace' }}>
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
                      color: '#c8975a',
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
