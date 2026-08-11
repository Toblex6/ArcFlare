// src/components/CheckoutWidget.tsx
//
// Core payment widget, extracted from the original hosted checkout page
// (src/app/checkout/[reference]/page.tsx) so the exact same wallet-connect
// → writeContract → verify-onchain flow can be reused in three places:
//   1. The existing full-page hosted checkout (wraps this + its own
//      "Payment Status" side panel + page chrome)
//   2. The new /checkout/embed/[reference] route (renders this alone,
//      sized for an iframe)
//   3. Any future in-app checkout modal, if ever needed
//
// PAYMENT METHODS: built with a method-tabs shell from the start, even
// though only one method ("wallet") is wired today. Adding CCTP later
// means adding a new entry to PAYMENT_METHODS + a new method component —
// not another redesign of this file or the pages that use it.
//
// FIX: injected() throws wagmi's raw internal "Provider not found.
// Version: @wagmi/core@x.x.x" error when clicked in a browser with no
// wallet extension. That's correct behavior from wagmi, but showing the
// raw internal string to a real customer is a bad experience. The button
// itself is intentionally NOT hidden pre-emptively — some wallets register
// via EIP-6963 events rather than window.ethereum, so a naive
// availability check could hide a connector that actually works. Instead,
// the error message shown after a failed click is translated into
// something a non-technical payer can act on.

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useAccount, useConnect, useDisconnect, useWriteContract, useChainId, useSwitchChain } from 'wagmi';
import { parseUnits } from 'viem';
import { USDC_CONTRACT, USDC_DECIMALS, erc20TransferAbi } from '@/src/lib/wallet/erc20';
import { arcTestnet } from '@/src/lib/wagmi';

export interface PaymentLogData {
    reference: string;
    amount: number;
    currency: string;
    chain: string;
    gateway_response: string;
    status: string;
    sender_email: string;
    merchant: string;
    merchant_username?: string | null;
    merchantSCA: string | null;
    paid_at: string | null;
    arcTxHash: string | null;
}

interface AgentData {
    name: string;
    scaAddress: string;
    tokenId: string;
    circleWalletId: string | null;
    status: string;
}

export type CheckoutEvent =
    | { type: 'ready' }
    | { type: 'status', payment: PaymentLogData }
    | { type: 'wallet_connected', address: string }
    | { type: 'payment_pending' }
    | { type: 'payment_success', payment: PaymentLogData }
    | { type: 'payment_error', error: string };

type PaymentMethodKey = 'wallet' | 'cctp';

const PAYMENT_METHODS: { key: PaymentMethodKey; label: string; available: boolean }[] = [
    { key: 'wallet', label: 'Pay from Wallet', available: true },
    { key: 'cctp', label: 'Pay Cross-Chain (CCTP)', available: true },
];

// Small curated list for the source-chain selector — testnet domains this
// deployment's CCTP pipeline recognizes (src/lib/cctp.ts's CHAIN_DOMAINS).
// Duplicated here rather than importing cctp.ts client-side, since that
// module also pulls in server-only signing logic with no business in the
// browser bundle.
const CCTP_SOURCE_DOMAINS = [
    { domain: 3, label: 'Arbitrum' },
    { domain: 6, label: 'Base' },
    { domain: 0, label: 'Ethereum' },
    { domain: 2, label: 'Optimism' },
    { domain: 7, label: 'Polygon' },
];

// Translates wagmi's raw connect() errors into copy a real payer can act
// on. Only touches the specific "no provider in this browser" case — any
// other error (user rejected the request, wrong network, etc.) still shows
// through with its own message, unchanged from before.
function friendlyConnectError(err: { message?: string; name?: string } | null | undefined): string {
    const msg = err?.message || '';
    if (msg.toLowerCase().includes('provider not found')) {
        return 'No wallet extension detected in this browser. Try WalletConnect to pay from your phone, or scan the QR code above.';
    }
    return msg || 'Could not connect. Make sure you have a wallet app installed.';
}

interface CheckoutWidgetProps {
    reference: string;
    /** Compact mode drops page-level chrome (logo header) for iframe/embed use. */
    compact?: boolean;
    /** Fires on every meaningful lifecycle event — used by the embed page to postMessage to the parent frame. */
    onEvent?: (event: CheckoutEvent) => void;
}

export default function CheckoutWidget({ reference, compact = false, onEvent }: CheckoutWidgetProps) {
    const [payment, setPayment] = useState<PaymentLogData | null>(null);
    const [agent, setAgent] = useState<AgentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isTxPending, setIsTxPending] = useState(false);
    const [isVerifying, setIsVerifying] = useState(false);
    const [settleError, setSettleError] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(900);
    const [method, setMethod] = useState<PaymentMethodKey>('wallet');
    const [cctpTxHash, setCctpTxHash] = useState('');
    const [cctpDomain, setCctpDomain] = useState(6); // default Base
    const [cctpSubmitting, setCctpSubmitting] = useState(false);
    const [cctpError, setCctpError] = useState<string | null>(null);

    const { address, isConnected } = useAccount();
    const { connectors, connect, error: connectError, isPending: isConnecting, reset: resetConnect } = useConnect();
    const { disconnect } = useDisconnect();
    const { writeContractAsync } = useWriteContract();
    const chainId = useChainId();
    const { switchChainAsync } = useSwitchChain();
    const [networkMismatch, setNetworkMismatch] = useState(false);

    const fetchLedgerStatus = useCallback(async () => {
        if (!reference) return;
        try {
            const res = await fetch(`/api/payments/verify/${reference}`);
            const result = await res.json();
            if (result.status === true && result.data) {
                setPayment(result.data);
                setError(null);
                onEvent?.({ type: 'status', payment: result.data });
                if (result.data.status === 'SUCCESS') {
                    onEvent?.({ type: 'payment_success', payment: result.data });
                }
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reference]);

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
    }, [reference, fetchLedgerStatus]);

    useEffect(() => {
        onEvent?.({ type: 'ready' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (isConnected && address) onEvent?.({ type: 'wallet_connected', address });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isConnected, address]);

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
            setNetworkMismatch(false);
            setIsTxPending(true);
            onEvent?.({ type: 'payment_pending' });

            if (chainId !== arcTestnet.id) {
                try {
                    await switchChainAsync({ chainId: arcTestnet.id });
                } catch {
                    setIsTxPending(false);
                    setNetworkMismatch(true);
                    const msg = 'Your wallet could not switch networks automatically. Please add Arc Testnet manually — details below — then try again.';
                    setSettleError(msg);
                    onEvent?.({ type: 'payment_error', error: msg });
                    return;
                }
            }

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
            const msg = err.shortMessage || err.message || 'Payment failed. Please try again.';
            setSettleError(msg);
            onEvent?.({ type: 'payment_error', error: msg });
        }
    };

    const handleCctpVerify = async () => {
        if (!reference || !cctpTxHash.trim()) return;
        setCctpSubmitting(true);
        setCctpError(null);
        onEvent?.({ type: 'payment_pending' });
        try {
            const res = await fetch('/api/payments/cctp-settle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference, sourceTxHash: cctpTxHash.trim(), sourceDomain: cctpDomain }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Could not verify the cross-chain transfer.');
            await fetchLedgerStatus();
        } catch (err: any) {
            const msg = err.message || 'Verification failed. The transfer may still be confirming — try again shortly.';
            setCctpError(msg);
            onEvent?.({ type: 'payment_error', error: msg });
        } finally {
            setCctpSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div style={{ padding: 24, textAlign: 'center' }}>
                <p style={{ color: '#c8975a', fontFamily: 'monospace', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' }}>
                    Syncing FlareHQ Ledger Parameters...
                </p>
            </div>
        );
    }

    if (error || !payment) {
        return (
            <div style={{ background: '#1a1410', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 24, padding: 24, textAlign: 'center' }}>
                <p style={{ color: '#f87171', fontWeight: 700, marginBottom: 8, fontSize: 16 }}>Ledger Disconnect</p>
                <p style={{ color: '#6b5a45', fontSize: 12 }}>{error || 'The reference could not be found.'}</p>
            </div>
        );
    }

    const isConfirmed = payment.status === 'SUCCESS';

    const walletDisplayAddress = isConnected && address
        ? address
        : agent?.scaAddress
            ? agent.scaAddress
            : payment.sender_email && payment.sender_email.startsWith('0x')
                ? payment.sender_email
                : 'Awaiting wallet connection...';

    const displayName = agent?.name || 'Autonomous Agent';

    return (
        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: compact ? 20 : 'clamp(20px, 3vw, 32px)', maxWidth: compact ? 440 : undefined, width: '100%', boxSizing: 'border-box', fontFamily: 'Inter, system-ui, sans-serif' }}>
            {!compact && (
                <>
                    <p style={{ color: '#c8975a', fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, fontFamily: 'monospace', margin: '0 0 8px' }}>Checkout</p>
                    <h2 style={{ fontSize: 24, fontWeight: 800, color: '#f0ece6', margin: '0 0 20px', lineHeight: 1.2 }}>Complete your payment</h2>
                </>
            )}

            {/* Payment method tabs — only "wallet" is wired; others render disabled until built */}
            {PAYMENT_METHODS.length > 1 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 18, borderBottom: '1px solid #2d2015', paddingBottom: 12 }}>
                    {PAYMENT_METHODS.map((m) => (
                        <button
                            key={m.key}
                            onClick={() => m.available && setMethod(m.key)}
                            disabled={!m.available}
                            title={!m.available ? 'Coming soon' : undefined}
                            style={{
                                padding: '6px 12px',
                                borderRadius: 8,
                                border: 'none',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: m.available ? 'pointer' : 'not-allowed',
                                background: method === m.key ? 'rgba(200,151,90,0.15)' : 'transparent',
                                color: method === m.key ? '#c8975a' : m.available ? '#6b5a45' : '#3d332a',
                            }}
                        >
                            {m.label}{!m.available && ' (soon)'}
                        </button>
                    ))}
                </div>
            )}

            <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{ background: '#fff', padding: 8, borderRadius: 10 }}>
                    <img src={`/api/checkout/qr?reference=${reference}`} alt="Scan to pay from your phone" width={compact ? 140 : 180} height={compact ? 140 : 180} style={{ display: 'block' }} />
                </div>
                <p style={{ color: '#6b5a45', fontSize: 11, margin: 0, textAlign: 'center' }}>Scan to pay from your phone</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22 }}>
                {[
                    { label: 'Merchant', value: payment.merchant_username ? `@${payment.merchant_username}` : (payment.merchant || 'FlareHQ Merchant') },
                    { label: 'Reference', value: payment.reference, mono: true, truncate: true },
                    { label: 'Amount Due', value: payment.amount.toString(), highlight: true },
                ].map((row, i) => (
                    <div key={i} style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <span style={{ color: '#6b5a45', fontSize: 12 }}>{row.label}</span>
                        <span style={{ fontSize: row.highlight ? 18 : 12, fontWeight: row.highlight ? 800 : 500, color: '#f0ece6', fontFamily: row.mono ? 'monospace' : 'inherit' }}>
                            {row.truncate && row.value.length > 20 ? `${row.value.slice(0, 20)}...` : row.value}
                            {row.highlight && <span style={{ color: '#c8975a', fontSize: 12, marginLeft: 6 }}>{payment.currency}</span>}
                        </span>
                    </div>
                ))}

                <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: '12px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: agent ? 8 : 0, flexWrap: 'wrap', gap: 6 }}>
                        <span style={{ color: '#6b5a45', fontSize: 12 }}>Connected Wallet</span>
                        {agent && <span style={{ fontSize: 9, color: '#c8975a', fontFamily: 'monospace', background: 'rgba(200,151,90,0.1)', border: '1px solid rgba(200,151,90,0.2)', padding: '2px 8px', borderRadius: 10 }}>ERC-8004 #{agent.tokenId}</span>}
                    </div>
                    <p style={{ color: isConnected || agent ? '#f0ece6' : '#6b5a45', fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', margin: '4px 0 0' }}>{walletDisplayAddress}</p>
                    {agent && <p style={{ color: '#6b5a45', fontSize: 10, margin: '4px 0 0' }}>{displayName} • Circle SCA • {agent.status}</p>}
                </div>
            </div>

            {method === 'wallet' && (
                <>
                    {!isConnected ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {(() => {
                                // If a browser wallet extension is already injected (MetaMask,
                                // Rabby, etc), the injected() connector and the walletConnect()
                                // connector both end up offering to connect to the SAME wallet —
                                // and injected() often literally names itself "MetaMask" too, so
                                // both buttons can read identically. Clicking the WalletConnect
                                // one then routes through WC's relay servers to bridge back to an
                                // extension that's already sitting right there in the same
                                // browser — this is the "stuck on Continue in MetaMask, then
                                // resets" failure. Fix: when an injected provider exists, connect
                                // to IT directly as the single primary option, and only offer
                                // WalletConnect as an explicitly-labeled secondary path (for
                                // scanning with a phone) — never two same-named buttons.
                                const hasInjectedProvider = typeof window !== 'undefined' && !!(window as any).ethereum;
                                const injectedConnector = connectors.find((c) => c.type === 'injected');
                                const walletConnectConnector = connectors.find((c) => c.type === 'walletConnect');
                                const otherConnectors = connectors.filter(
                                    (c) => c.type !== 'injected' && c.type !== 'walletConnect'
                                );

                                const attemptConnect = (c: (typeof connectors)[number]) => {
                                    // Clear any stuck pending/error state from a previously
                                    // aborted attempt before starting a new one — without this,
                                    // wagmi can leave isPending/error set from the last reset
                                    // WalletConnect session, making the button look dead on retry.
                                    resetConnect();
                                    connect({ connector: c });
                                };

                                return (
                                    <>
                                        {hasInjectedProvider && injectedConnector && (
                                            <button
                                                key={injectedConnector.uid}
                                                onClick={() => attemptConnect(injectedConnector)}
                                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: 'pointer', background: '#251c12', color: '#f0ece6' }}
                                            >
                                                {isConnecting ? 'Connecting...' : `Connect ${injectedConnector.name}`}
                                            </button>
                                        )}
                                        {walletConnectConnector && (
                                            <button
                                                key={walletConnectConnector.uid}
                                                onClick={() => attemptConnect(walletConnectConnector)}
                                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: 'pointer', background: '#251c12', color: '#f0ece6' }}
                                            >
                                                {isConnecting ? 'Connecting...' : hasInjectedProvider ? 'Scan QR with Mobile Wallet' : 'Connect Wallet'}
                                            </button>
                                        )}
                                        {!hasInjectedProvider && injectedConnector && (
                                            // No extension detected at all (e.g. mobile browser with
                                            // no wallet app injecting a provider) — still offer it,
                                            // clearly labeled, rather than hiding it silently.
                                            <button
                                                key={injectedConnector.uid}
                                                onClick={() => attemptConnect(injectedConnector)}
                                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: 'pointer', background: '#251c12', color: '#f0ece6' }}
                                            >
                                                {isConnecting ? 'Connecting...' : `Connect ${injectedConnector.name}`}
                                            </button>
                                        )}
                                        {otherConnectors.map((c) => (
                                            <button
                                                key={c.uid}
                                                onClick={() => attemptConnect(c)}
                                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: 'pointer', background: '#251c12', color: '#f0ece6' }}
                                            >
                                                {isConnecting ? 'Connecting...' : `Connect ${c.name}`}
                                            </button>
                                        ))}
                                    </>
                                );
                            })()}
                            {connectError && (
                                <p style={{ color: '#f87171', fontSize: 11, margin: '4px 0 0' }}>
                                    ⚠️ {friendlyConnectError(connectError)}
                                </p>
                            )}
                        </div>
                    ) : (
                        <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#6b5a45' }}>
                                <span>Connected: {address?.slice(0, 6)}...{address?.slice(-4)}</span>
                                <button onClick={() => disconnect()} style={{ background: 'none', border: 'none', color: '#c8975a', cursor: 'pointer', fontSize: 'inherit' }}>
                                    Disconnect
                                </button>
                            </div>
                            <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: 10, fontSize: 11, color: '#6b5a45', textDecoration: 'underline' }}>
                                No test USDC? Get some free ↗
                            </a>
                            <button
                                onClick={handlePayment}
                                disabled={isTxPending || isVerifying || isConfirmed || secondsLeft === 0}
                                style={{
                                    width: '100%',
                                    padding: 16,
                                    borderRadius: 14,
                                    border: 'none',
                                    fontSize: 14,
                                    fontWeight: 800,
                                    cursor: isConfirmed || secondsLeft === 0 ? 'default' : isTxPending || isVerifying ? 'not-allowed' : 'pointer',
                                    background: isConfirmed ? 'rgba(6,182,212,0.1)' : isTxPending || isVerifying ? '#6b5a45' : '#c8975a',
                                    color: isConfirmed ? '#06b6d4' : '#0e0b08',
                                }}
                            >
                                {isConfirmed ? '✓ Payment Confirmed' : isTxPending ? '⏳ Confirm in your wallet...' : isVerifying ? '🔍 Verifying on-chain...' : secondsLeft === 0 ? 'Link Expired' : `Pay ${payment.amount} ${payment.currency}`}
                            </button>
                        </>
                    )}
                </>
            )}

            {method === 'cctp' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>
                        Send {payment.amount} USDC from another chain using your own wallet, then paste the transaction hash below to verify and settle.
                    </p>
                    <div>
                        <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Source Chain</p>
                        <select
                            value={cctpDomain}
                            onChange={(e) => setCctpDomain(Number(e.target.value))}
                            disabled={cctpSubmitting || isConfirmed}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6', fontSize: 13 }}
                        >
                            {CCTP_SOURCE_DOMAINS.map((d) => (
                                <option key={d.domain} value={d.domain}>{d.label}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Burn Transaction Hash</p>
                        <input
                            value={cctpTxHash}
                            onChange={(e) => setCctpTxHash(e.target.value)}
                            placeholder="0x..."
                            disabled={cctpSubmitting || isConfirmed}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6', fontSize: 13, fontFamily: 'monospace', boxSizing: 'border-box' }}
                        />
                    </div>
                    <button
                        onClick={handleCctpVerify}
                        disabled={cctpSubmitting || isConfirmed || !cctpTxHash.trim()}
                        style={{
                            width: '100%',
                            padding: 16,
                            borderRadius: 14,
                            border: 'none',
                            fontSize: 14,
                            fontWeight: 800,
                            cursor: cctpSubmitting || isConfirmed || !cctpTxHash.trim() ? 'not-allowed' : 'pointer',
                            background: isConfirmed ? 'rgba(6,182,212,0.1)' : cctpSubmitting ? '#6b5a45' : '#c8975a',
                            color: isConfirmed ? '#06b6d4' : '#0e0b08',
                        }}
                    >
                        {isConfirmed ? '✓ Payment Confirmed' : cctpSubmitting ? '🔍 Verifying attestation...' : 'Verify & Settle'}
                    </button>
                    {cctpError && (
                        <p style={{ color: '#f87171', fontSize: 11, margin: 0 }}>❌ {cctpError}</p>
                    )}
                    <p style={{ fontSize: 10, color: '#4b4035', margin: 0 }}>
                        Attestation typically takes 1–3 minutes. This page will update automatically once settled.
                    </p>
                </div>
            )}

            {settleError && (
                <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: 14, textAlign: 'center' }}>
                    <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {settleError}</p>
                </div>
            )}

            {networkMismatch && (
                <div style={{ marginTop: 12, background: '#1a1410', border: '1px solid #2d2015', borderRadius: 12, padding: 14 }}>
                    <p style={{ color: '#c8975a', fontSize: 12, fontWeight: 700, margin: '0 0 8px' }}>Add this network manually in your wallet:</p>
                    {[
                        ['Network Name', 'Arc Testnet'],
                        ['Chain ID', String(arcTestnet.id)],
                        ['RPC URL', arcTestnet.rpcUrls.default.http[0]],
                        ['Currency Symbol', 'ARC'],
                        ['Block Explorer', arcTestnet.blockExplorers.default.url],
                    ].map(([label, value]) => (
                        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: '#a89684', padding: '4px 0', borderBottom: '1px solid #2d2015' }}>
                            <span>{label}</span>
                            <span style={{ color: '#f0ece6', fontFamily: 'monospace', cursor: 'pointer', wordBreak: 'break-all', textAlign: 'right' }} onClick={() => navigator.clipboard.writeText(value)} title="Tap to copy">
                                {value}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {isConfirmed && (
                <div style={{ marginTop: 16, background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 14, padding: 16, textAlign: 'center' }}>
                    <p style={{ color: '#06b6d4', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>✓ Payment settled on Arc Testnet</p>
                    <p style={{ color: '#4b4035', fontSize: 10, margin: 0 }}>Ledger updated · Dashboard synced</p>
                </div>
            )}
        </div>
    );
}
