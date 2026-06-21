//src\app\checkout\[reference]\page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';

interface PaymentLogData {
  reference: string;
  amount: number;
  currency: string;
  chain: string;
  gateway_response: string;
  status: string;
  sender_email: string;
  merchant: string;
  paid_at: string | null;
}

interface AgentData {
  name: string;
  scaAddress: string;
  tokenId: string;
  circleWalletId: string | null;
  status: string;
}

// The dashboard API key — used to call internal settle endpoint from the UI
const INTERNAL_API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || '';

export default function CheckoutPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference;

  const [payment, setPayment] = useState<PaymentLogData | null>(null);
  const [agent, setAgent] = useState<AgentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isTxPending, setIsTxPending] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  const fetchLedgerStatus = async (txHash?: string) => {
    if (!reference) return;
    try {
      let url = `/api/payments/verify/${reference}`;
      if (txHash) url += `?txHash=${txHash}`;
      const res = await fetch(url);
      const result = await res.json();
      if (result.status === true && result.data) {
        setPayment(result.data);
        setError(null);
        const senderEmail = result.data.sender_email;
        if (senderEmail && senderEmail.startsWith('0x') && !agent) {
          fetchAgentWallet(senderEmail);
        }
      } else {
        setError(result.message || 'Failed to resolve reference ledger entry.');
      }
    } catch {
      setError('Operational server error while syncing transactions.');
    } finally {
      setLoading(false);
    }
  };

  const fetchAgentWallet = async (scaAddress: string) => {
    try {
      const res = await fetch(`/api/agent/status?scaAddress=${scaAddress}`);
      const data = await res.json();
      if (data.success && data.agents?.length > 0) {
        setAgent(data.agents[0]);
      }
    } catch {
      // Agent not in registry — use address as-is
    }
  };

  useEffect(() => {
    if (reference) fetchLedgerStatus();
  }, [reference]);

  // ── REAL Payment Handler ──────────────────────────────────────────────────
  const handlePayment = async () => {
    if (!reference || !payment) return;

    try {
      setSettleError(null);
      setIsTxPending(true);

      // Call the real settle endpoint with the API key
      const settleRes = await fetch('/api/payments/settle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': INTERNAL_API_KEY,
        },
        body: JSON.stringify({ reference }),
      });

      const settleData = await settleRes.json();

      if (!settleRes.ok || !settleData.success) {
        throw new Error(settleData.error || settleData.message || 'Settlement failed.');
      }

      setIsTxPending(false);
      setIsVerifying(true);

      // Verify updated status from DB
      await fetchLedgerStatus();
      setIsVerifying(false);
    } catch (err: any) {
      setIsTxPending(false);
      setIsVerifying(false);
      setSettleError(err.message || 'Payment failed. Please try again.');
    }
  };

  if (loading) {
    return (
      <main
        style={{
          minHeight: '100vh',
          background: '#0e0b08',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            color: '#c8975a',
            fontFamily: 'monospace',
            fontSize: 12,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          Syncing ArcFlare Ledger Parameters...
        </p>
      </main>
    );
  }

  if (error || !payment) {
    return (
      <main
        style={{
          minHeight: '100vh',
          background: '#0e0b08',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <div
          style={{
            background: '#1a1410',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 24,
            padding: 40,
            maxWidth: 400,
            textAlign: 'center',
          }}
        >
          <p style={{ color: '#f87171', fontWeight: 700, marginBottom: 8 }}>Ledger Disconnect</p>
          <p style={{ color: '#6b5a45', fontSize: 13 }}>
            {error || 'The reference could not be found.'}
          </p>
        </div>
      </main>
    );
  }

  const isConfirmed = payment.status === 'SUCCESS';
  const displayAddress =
    agent?.scaAddress || payment.sender_email || '0xArcFlare...AutonomousAgent';
  const displayName = agent?.name || 'Autonomous Agent';

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0e0b08',
        color: '#f0ece6',
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: '32px 24px',
      }}
    >
      {/* Header */}
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={44}
            height={44}
            style={{ borderRadius: 10, objectFit: 'contain' }}
          />
          <div>
            <p
              style={{
                color: '#f0ece6',
                fontSize: 16,
                fontWeight: 700,
                margin: 0,
                letterSpacing: -0.3,
              }}
            >
              ARCFLARE
            </p>
            <p style={{ color: '#6b5a45', fontSize: 11, margin: 0 }}>
              Stablecoin Payment Infrastructure
            </p>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: '#1a1410',
            border: '1px solid #2d2015',
            borderRadius: 20,
            padding: '6px 14px',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#06b6d4',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              fontSize: 10,
              color: '#06b6d4',
              fontWeight: 600,
              fontFamily: 'monospace',
              letterSpacing: 1,
            }}
          >
            ROUTING NODE // ONLINE
          </span>
        </div>
      </div>

      {/* Main Grid */}
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 24,
        }}
      >
        {/* LEFT — Checkout Details */}
        <div
          style={{
            background: '#1a1410',
            border: '1px solid #2d2015',
            borderRadius: 24,
            padding: 32,
          }}
        >
          <p
            style={{
              color: '#c8975a',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: 2,
              fontFamily: 'monospace',
              margin: '0 0 8px',
            }}
          >
            Hosted Checkout
          </p>
          <h2
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: '#f0ece6',
              margin: '0 0 28px',
              lineHeight: 1.2,
            }}
          >
            Seamless Stablecoin Payments on Arc
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
            {[
              { label: 'Merchant', value: payment.merchant || 'ArcFlare Merchant' },
              { label: 'Payment Reference', value: payment.reference, mono: true, truncate: true },
              {
                label: 'Amount Due',
                value: `${payment.amount} ${payment.currency}`,
                highlight: true,
              },
              { label: 'Target Settlement Layer', value: payment.chain, cyan: true },
              { label: 'Connected Chain ID', value: '5042002', cyan: true },
            ].map((row, i) => (
              <div
                key={i}
                style={{
                  background: '#251c12',
                  border: '1px solid #3d2e1a',
                  borderRadius: 14,
                  padding: '14px 18px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ color: '#6b5a45', fontSize: 13 }}>{row.label}</span>
                <span
                  style={{
                    fontSize: row.highlight ? 20 : 13,
                    fontWeight: row.highlight ? 800 : 500,
                    color: row.highlight ? '#f0ece6' : row.cyan ? '#06b6d4' : '#f0ece6',
                    fontFamily: row.mono ? 'monospace' : 'inherit',
                  }}
                >
                  {row.truncate && row.value.length > 20
                    ? `${row.value.slice(0, 20)}...`
                    : row.value}
                  {row.highlight && (
                    <span style={{ color: '#c8975a', fontSize: 14, marginLeft: 6 }}>
                      {payment.currency}
                    </span>
                  )}
                </span>
              </div>
            ))}

            {/* Agent Wallet */}
            <div
              style={{
                background: '#251c12',
                border: '1px solid #3d2e1a',
                borderRadius: 14,
                padding: '14px 18px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: agent ? 8 : 0,
                }}
              >
                <span style={{ color: '#6b5a45', fontSize: 13 }}>Connected Wallet</span>
                {agent && (
                  <span
                    style={{
                      fontSize: 10,
                      color: '#c8975a',
                      fontFamily: 'monospace',
                      background: 'rgba(200,151,90,0.1)',
                      border: '1px solid rgba(200,151,90,0.2)',
                      padding: '2px 8px',
                      borderRadius: 10,
                    }}
                  >
                    ERC-8004 #{agent.tokenId}
                  </span>
                )}
              </div>
              <p
                style={{
                  color: '#f0ece6',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                  margin: '4px 0 0',
                }}
              >
                {displayAddress}
              </p>
              {agent && (
                <p style={{ color: '#6b5a45', fontSize: 10, margin: '4px 0 0' }}>
                  {displayName} • Circle SCA • {agent.status}
                </p>
              )}
            </div>
          </div>

          {/* Pay Button */}
          <button
            onClick={handlePayment}
            disabled={isTxPending || isVerifying || isConfirmed}
            style={{
              width: '100%',
              padding: '16px',
              borderRadius: 14,
              border: 'none',
              fontSize: 15,
              fontWeight: 800,
              cursor: isConfirmed
                ? 'default'
                : isTxPending || isVerifying
                  ? 'not-allowed'
                  : 'pointer',
              background: isConfirmed
                ? 'rgba(6,182,212,0.1)'
                : isTxPending || isVerifying
                  ? '#6b5a45'
                  : '#c8975a',
              color: isConfirmed ? '#06b6d4' : '#0e0b08',
              letterSpacing: 0.3,
              transition: 'all 0.15s',
            }}
          >
            {isConfirmed
              ? '✓ Ledger Settlement Confirmed'
              : isTxPending
                ? '⏳ Submitting to Arc Testnet...'
                : isVerifying
                  ? '🔍 Verifying Settlement...'
                  : `Pay ${payment.amount} ${payment.currency}`}
          </button>

          {settleError && (
            <div
              style={{
                marginTop: 12,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 12,
                padding: 14,
                textAlign: 'center',
              }}
            >
              <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {settleError}</p>
            </div>
          )}

          {isConfirmed && (
            <div
              style={{
                marginTop: 16,
                background: 'rgba(6,182,212,0.06)',
                border: '1px solid rgba(6,182,212,0.15)',
                borderRadius: 14,
                padding: 16,
                textAlign: 'center',
              }}
            >
              <p style={{ color: '#06b6d4', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>
                ✓ Payment settled on Arc Testnet
              </p>
              <p style={{ color: '#4b4035', fontSize: 11, margin: 0 }}>
                Ledger updated · Dashboard synced
              </p>
            </div>
          )}
        </div>

        {/* RIGHT — Payment Gateway Tracking */}
        <div
          style={{
            background: '#1a1410',
            border: '1px solid #2d2015',
            borderRadius: 24,
            padding: 32,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <h3 style={{ fontSize: 20, fontWeight: 700, color: '#f0ece6', margin: 0 }}>
            Payment Gateway Tracking
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div
              style={{
                background: '#251c12',
                border: '1px solid #3d2e1a',
                borderRadius: 14,
                padding: 18,
              }}
            >
              <p
                style={{
                  color: '#6b5a45',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  margin: '0 0 6px',
                }}
              >
                Network Status
              </p>
              <p
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: isConfirmed ? '#06b6d4' : isTxPending ? '#c8975a' : '#f59e0b',
                  margin: 0,
                  fontFamily: 'monospace',
                }}
              >
                {isConfirmed ? 'SUCCESS' : isTxPending ? 'SETTLING' : 'PENDING'}
              </p>
            </div>
            <div
              style={{
                background: '#251c12',
                border: '1px solid #3d2e1a',
                borderRadius: 14,
                padding: 18,
              }}
            >
              <p
                style={{
                  color: '#6b5a45',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  margin: '0 0 6px',
                }}
              >
                System Response
              </p>
              <p style={{ fontSize: 18, fontWeight: 800, color: '#f0ece6', margin: 0 }}>
                {payment.gateway_response}
              </p>
            </div>
          </div>

          <div
            style={{
              background: '#251c12',
              border: '1px solid #3d2e1a',
              borderRadius: 14,
              padding: 18,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ color: '#6b5a45', fontSize: 13 }}>
                Gateway Infrastructure Success Rate
              </span>
              <span style={{ color: '#c8975a', fontWeight: 700, fontSize: 13 }}>98.2%</span>
            </div>
            <div style={{ height: 6, background: '#0e0b08', borderRadius: 3, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: '98.2%',
                  background: 'linear-gradient(90deg, #c8975a, #e8b87a)',
                  borderRadius: 3,
                }}
              />
            </div>
          </div>

          <div
            style={{
              background: '#251c12',
              border: '1px solid #3d2e1a',
              borderRadius: 14,
              padding: 18,
              flex: 1,
            }}
          >
            <h4 style={{ fontSize: 14, fontWeight: 700, color: '#f0ece6', margin: '0 0 16px' }}>
              Current Ledger Instance
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                {
                  label: 'Reference Token',
                  value: `${payment.reference.slice(0, 16)}...`,
                  color: '#06b6d4',
                },
                {
                  label: 'Payer Entity',
                  value: displayAddress.slice(0, 30) + '...',
                  color: '#f0ece6',
                },
                {
                  label: 'Agent Identity',
                  value: agent ? `ERC-8004 Token #${agent.tokenId}` : 'Autonomous Agent',
                  color: '#c8975a',
                },
                {
                  label: 'Settled Block Time',
                  value: payment.paid_at
                    ? new Date(payment.paid_at).toLocaleString()
                    : 'Awaiting settlement',
                  color: '#6b5a45',
                },
              ].map((row, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ color: '#6b5a45', fontSize: 12 }}>{row.label}</span>
                  <span style={{ color: row.color, fontSize: 11, fontFamily: 'monospace' }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {isConfirmed && (
            <div
              style={{
                background: 'rgba(13,124,95,0.1)',
                border: '1px solid rgba(13,124,95,0.25)',
                borderRadius: 14,
                padding: 16,
                textAlign: 'center',
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  color: '#0d7c5f',
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  margin: '0 0 4px',
                  letterSpacing: 1,
                }}
              >
                M2M_AUTO_SETTLE
              </p>
              <p style={{ fontSize: 10, color: '#4b5563', margin: 0 }}>
                Settled autonomously via ArcFlare agent pipeline
              </p>
            </div>
          )}

          <div
            style={{
              background: '#0e0b08',
              border: '1px solid rgba(200,151,90,0.15)',
              borderRadius: 14,
              padding: 16,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Image
                  src="/arcflare-logo.png.png"
                  alt="ArcFlare"
                  width={24}
                  height={24}
                  style={{ borderRadius: 6, objectFit: 'contain' }}
                />
                <p style={{ color: '#6b5a45', fontSize: 12, fontWeight: 600, margin: 0 }}>
                  ArcFlare Engine
                </p>
              </div>
              <span
                style={{
                  fontSize: 10,
                  color: '#c8975a',
                  fontFamily: 'monospace',
                  background: 'rgba(200,151,90,0.1)',
                  border: '1px solid rgba(200,151,90,0.2)',
                  padding: '2px 8px',
                  borderRadius: 10,
                }}
              >
                Active Rails
              </span>
            </div>
            <p style={{ fontSize: 11, color: '#4b4035', lineHeight: 1.5, margin: 0 }}>
              ArcFlare is building programmable stablecoin settlement infrastructure on Arc with
              native support for Circle CCTP V2 cross-chain machine execution protocols.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
