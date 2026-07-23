//src/app/checkout/[reference]/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { useAccount, useConnect, useDisconnect, useWriteContract } from 'wagmi';
import { parseUnits } from 'viem';
import { USDC_CONTRACT, USDC_DECIMALS, erc20TransferAbi } from '@/src/lib/wallet/erc20';

interface PaymentLogData {
  reference: string;
  amount: number;
  currency: string;
  chain: string;
  gateway_response: string;
  status: string;
  sender_email: string;
  merchant: string;
  merchantSCA: string | null;
  paid_at: string | null;
}

interface AgentData {
  name: string;
  scaAddress: string;
  tokenId: string;
  circleWalletId: string | null;
  status: string;
}

export default function CheckoutPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference;

  const [payment, setPayment] = useState<PaymentLogData | null>(null);
  const [agent, setAgent] = useState<AgentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isTxPending, setIsTxPending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(900); // 15-minute link expiration timer

  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();

  const fetchLedgerStatus = async () => {
    if (!reference) return;
    try {
      const res = await fetch(`/api/payments/verify/${reference}`);
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
    } catch { }
  };

  useEffect(() => {
    if (reference) fetchLedgerStatus();
  }, [reference]);

  // Payment Link Expiry Countdown Timer
  useEffect(() => {
    if (payment?.status === 'SUCCESS') return;
    const timer = setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [payment?.status]);

  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handlePayment = async () => {
    if (!reference || !payment) return;
    if (!payment.merchantSCA) {
      setSettleError('This merchant has not finished payout wallet setup yet. Cannot accept payment.');
      return;
    }
    if (!isConnected || !address) {
      setSettleError('Connect a wallet first.');
      return;
    }

    try {
      setSettleError(null);
      setIsTxPending(true);

      const txHash = await writeContractAsync({
        address: USDC_CONTRACT as `0x${string}`,
        abi: erc20TransferAbi,
        functionName: 'transfer',
        args: [payment.merchantSCA as `0x${string}`, parseUnits(payment.amount.toString(), USDC_DECIMALS)],
      });

      setIsTxPending(false);
      setIsVerifying(true);

      const verifyRes = await fetch('/api/payments/verify-onchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, txHash }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.success) {
        throw new Error(verifyData.error || 'Could not verify the transaction on-chain.');
      }

      await fetchLedgerStatus();
      setIsVerifying(false);
    } catch (err: any) {
      setIsTxPending(false);
      setIsVerifying(false);
      setSettleError(err.shortMessage || err.message || 'Payment failed. Please try again.');
    }
  };

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <p style={{ color: '#c8975a', fontFamily: 'monospace', fontSize: 'clamp(10px, 1.2vw, 14px)', letterSpacing: 2, textTransform: 'uppercase' }}>Syncing FlareHQ Ledger Parameters...</p>
      </main>
    );
  }

  if (error || !payment) {
    return (
      <main style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'clamp(16px, 3vw, 24px)' }}>
        <div style={{ background: '#1a1410', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 24, padding: 'clamp(24px, 5vw, 40px)', maxWidth: 400, textAlign: 'center', width: '100%' }}>
          <p style={{ color: '#f87171', fontWeight: 700, marginBottom: 8, fontSize: 'clamp(16px, 2vw, 20px)' }}>Ledger Disconnect</p>
          <p style={{ color: '#6b5a45', fontSize: 'clamp(12px, 1.2vw, 14px)' }}>{error || 'The reference could not be found.'}</p>
        </div>
      </main>
    );
  }

  const isConfirmed = payment.status === 'SUCCESS';

  // Wallet display logic: shows connected wallet when connected, agent address if present, or clean pending state
  const walletDisplayAddress = isConnected && address
    ? address
    : agent?.scaAddress
      ? agent.scaAddress
      : payment.sender_email && payment.sender_email.startsWith('0x')
        ? payment.sender_email
        : 'Awaiting wallet connection...';

  const displayName = agent?.name || 'Autonomous Agent';

  // Ledger Instance rows on the right card
  const ledgerRows = [];
  if (agent) {
    ledgerRows.push({
      label: 'Agent Identity',
      value: `ERC-8004 Token #${agent.tokenId}`,
      color: '#c8975a',
    });
  }
  if (isConfirmed) {
    ledgerRows.push({
      label: 'Settled Block Time',
      value: payment.paid_at ? new Date(payment.paid_at).toLocaleString() : 'Settled',
      color: '#06b6d4',
    });
  } else {
    ledgerRows.push({
      label: 'Link Expiry',
      value: secondsLeft > 0 ? `Expires in ${formatCountdown(secondsLeft)}` : 'Expired',
      color: secondsLeft > 0 ? '#f59e0b' : '#f87171',
    });
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', padding: 'clamp(16px, 3vw, 32px) clamp(12px, 2vw, 24px)' }}>
      {/* Header */}
      <div style={{ maxWidth: 1200, margin: '0 auto 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={44} height={44} style={{ borderRadius: 10, objectFit: 'contain' }} />
          <div>
            <p style={{ color: '#f0ece6', fontSize: 'clamp(14px, 2vw, 18px)', fontWeight: 700, margin: 0, letterSpacing: -0.3 }}>FLAREHQ</p>
            <p style={{ color: '#6b5a45', fontSize: 'clamp(10px, 1vw, 12px)', margin: 0 }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#1a1410', border: '1px solid #2d2015', borderRadius: 20, padding: '6px 14px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#06b6d4', display: 'inline-block' }} />
          <span style={{ fontSize: 'clamp(8px, 0.8vw, 10px)', color: '#06b6d4', fontWeight: 600, fontFamily: 'monospace', letterSpacing: 1 }}>ROUTING NODE // ONLINE</span>
        </div>
      </div>

      {/* Main Grid */}
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'clamp(16px, 2vw, 24px)' }}>
        {/* LEFT */}
        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(20px, 3vw, 32px)' }}>
          <p style={{ color: '#c8975a', fontSize: 'clamp(9px, 0.8vw, 11px)', textTransform: 'uppercase', letterSpacing: 2, fontFamily: 'monospace', margin: '0 0 8px' }}>Hosted Checkout</p>
          <h2 style={{ fontSize: 'clamp(22px, 4vw, 32px)', fontWeight: 800, color: '#f0ece6', margin: '0 0 28px', lineHeight: 1.2 }}>Seamless Stablecoin Payments on Arc</h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
            {[
              { label: 'Merchant', value: payment.merchant || 'FlareHQ Merchant' },
              { label: 'Payment Reference', value: payment.reference, mono: true, truncate: true },
              { label: 'Amount Due', value: payment.amount.toString(), highlight: true },
              { label: 'Target Settlement Layer', value: payment.chain, cyan: true },
              { label: 'Connected Chain ID', value: '5042002', cyan: true },
            ].map((row, i) => (
              <div key={i} style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(12px, 1.5vw, 16px) clamp(14px, 2vw, 18px)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ color: '#6b5a45', fontSize: 'clamp(11px, 1vw, 14px)' }}>{row.label}</span>
                <span style={{ fontSize: row.highlight ? 'clamp(16px, 2.5vw, 22px)' : 'clamp(12px, 1vw, 14px)', fontWeight: row.highlight ? 800 : 500, color: row.highlight ? '#f0ece6' : row.cyan ? '#06b6d4' : '#f0ece6', fontFamily: row.mono ? 'monospace' : 'inherit' }}>
                  {row.truncate && row.value.length > 20 ? `${row.value.slice(0, 20)}...` : row.value}
                  {row.highlight && <span style={{ color: '#c8975a', fontSize: 'clamp(12px, 1vw, 14px)', marginLeft: 6 }}>{payment.currency}</span>}
                </span>
              </div>
            ))}

            {/* Connected Wallet */}
            <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(12px, 1.5vw, 16px) clamp(14px, 2vw, 18px)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: agent ? 8 : 0, flexWrap: 'wrap', gap: 6 }}>
                <span style={{ color: '#6b5a45', fontSize: 'clamp(11px, 1vw, 14px)' }}>Connected Wallet</span>
                {agent && <span style={{ fontSize: 'clamp(8px, 0.8vw, 10px)', color: '#c8975a', fontFamily: 'monospace', background: 'rgba(200,151,90,0.1)', border: '1px solid rgba(200,151,90,0.2)', padding: '2px 8px', borderRadius: 10 }}>ERC-8004 #{agent.tokenId}</span>}
              </div>
              <p style={{ color: isConnected || agent ? '#f0ece6' : '#6b5a45', fontSize: 'clamp(11px, 1vw, 13px)', fontFamily: 'monospace', wordBreak: 'break-all', margin: '4px 0 0' }}>{walletDisplayAddress}</p>
              {agent && <p style={{ color: '#6b5a45', fontSize: 'clamp(9px, 0.8vw, 11px)', margin: '4px 0 0' }}>{displayName} • Circle SCA • {agent.status}</p>}
            </div>
          </div>

          {!isConnected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {connectors.map((c) => (
                <button
                  key={c.uid}
                  onClick={() => connect({ connector: c })}
                  style={{
                    width: '100%',
                    padding: 'clamp(14px, 1.8vw, 18px)',
                    borderRadius: 14,
                    border: '1px solid #3d2e1a',
                    fontSize: 'clamp(13px, 1.2vw, 16px)',
                    fontWeight: 700,
                    cursor: 'pointer',
                    background: '#251c12',
                    color: '#f0ece6',
                  }}
                >
                  Connect {c.name}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 'clamp(10px, 0.9vw, 12px)', color: '#6b5a45' }}>
                <span>Connected: {address?.slice(0, 6)}...{address?.slice(-4)}</span>
                <button onClick={() => disconnect()} style={{ background: 'none', border: 'none', color: '#c8975a', cursor: 'pointer', fontSize: 'inherit' }}>
                  Disconnect
                </button>
              </div>
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'block', marginBottom: 10, fontSize: 'clamp(10px, 0.9vw, 12px)', color: '#6b5a45', textDecoration: 'underline' }}
              >
                No test USDC? Get some free ↗
              </a>
              <button
                onClick={handlePayment}
                disabled={isTxPending || isVerifying || isConfirmed || secondsLeft === 0}
                style={{
                  width: '100%',
                  padding: 'clamp(14px, 1.8vw, 18px)',
                  borderRadius: 14,
                  border: 'none',
                  fontSize: 'clamp(13px, 1.2vw, 16px)',
                  fontWeight: 800,
                  cursor: isConfirmed || secondsLeft === 0 ? 'default' : isTxPending || isVerifying ? 'not-allowed' : 'pointer',
                  background: isConfirmed ? 'rgba(6,182,212,0.1)' : isTxPending || isVerifying ? '#6b5a45' : '#c8975a',
                  color: isConfirmed ? '#06b6d4' : '#0e0b08',
                  letterSpacing: 0.3,
                  transition: 'all 0.15s',
                }}
              >
                {isConfirmed ? '✓ Payment Confirmed' : isTxPending ? '⏳ Confirm in your wallet...' : isVerifying ? '🔍 Verifying on-chain...' : secondsLeft === 0 ? 'Link Expired' : `Pay ${payment.amount} ${payment.currency}`}
              </button>
            </>
          )}

          {settleError && (
            <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: 14, textAlign: 'center' }}>
              <p style={{ color: '#f87171', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0 }}>❌ {settleError}</p>
            </div>
          )}
          {isConfirmed && (
            <div style={{ marginTop: 16, background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 14, padding: 16, textAlign: 'center' }}>
              <p style={{ color: '#06b6d4', fontWeight: 700, fontSize: 'clamp(12px, 1vw, 14px)', margin: '0 0 4px' }}>✓ Payment settled on Arc Testnet</p>
              <p style={{ color: '#4b4035', fontSize: 'clamp(9px, 0.8vw, 11px)', margin: 0 }}>Ledger updated · Dashboard synced</p>
            </div>
          )}
        </div>

        {/* RIGHT */}
        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(20px, 3vw, 32px)', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h3 style={{ fontSize: 'clamp(18px, 2.5vw, 24px)', fontWeight: 700, color: '#f0ece6', margin: 0 }}>Payment Status</h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)' }}>
              <p style={{ color: '#6b5a45', fontSize: 'clamp(9px, 0.8vw, 11px)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Network Status</p>
              <p style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 800, color: isConfirmed ? '#06b6d4' : isTxPending ? '#c8975a' : '#f59e0b', margin: 0, fontFamily: 'monospace' }}>
                {isConfirmed ? 'SUCCESS' : isTxPending ? 'SETTLING' : 'PENDING'}
              </p>
            </div>
            <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)' }}>
              <p style={{ color: '#6b5a45', fontSize: 'clamp(9px, 0.8vw, 11px)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>System Response</p>
              <p style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 800, color: '#f0ece6', margin: 0 }}>{payment.gateway_response}</p>
            </div>
          </div>

          <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 4 }}>
              <span style={{ color: '#6b5a45', fontSize: 'clamp(11px, 1vw, 14px)' }}>Gateway Infrastructure Success Rate</span>
              <span style={{ color: '#c8975a', fontWeight: 700, fontSize: 'clamp(11px, 1vw, 14px)' }}>98.2%</span>
            </div>
            <div style={{ height: 6, background: '#0e0b08', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '98.2%', background: 'linear-gradient(90deg, #c8975a, #e8b87a)', borderRadius: 3 }} />
            </div>
          </div>

          <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)', flex: 1 }}>
            <h4 style={{ fontSize: 'clamp(13px, 1.2vw, 15px)', fontWeight: 700, color: '#f0ece6', margin: '0 0 16px' }}>Current Ledger Instance</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {ledgerRows.map((row, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  <span style={{ color: '#6b5a45', fontSize: 'clamp(10px, 0.9vw, 12px)' }}>{row.label}</span>
                  <span style={{ color: row.color, fontSize: 'clamp(9px, 0.8vw, 11px)', fontFamily: 'monospace' }}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {isConfirmed && (
            <div style={{ background: 'rgba(13,124,95,0.1)', border: '1px solid rgba(13,124,95,0.25)', borderRadius: 14, padding: 16, textAlign: 'center' }}>
              <p style={{ fontSize: 'clamp(10px, 0.9vw, 12px)', color: '#0d7c5f', fontFamily: 'monospace', fontWeight: 700, margin: '0 0 4px', letterSpacing: 1 }}>M2M_AUTO_SETTLE</p>
              <p style={{ fontSize: 'clamp(9px, 0.8vw, 11px)', color: '#4b5563', margin: 0 }}>Settled autonomously via FlareHQ agent pipeline</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}