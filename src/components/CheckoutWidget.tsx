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
import { useAccount, useConnect, useDisconnect, useWriteContract, useChainId, useSwitchChain, useReadContract } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { erc20TransferAbi } from '@/src/lib/wallet/erc20';
// Phase 2B: token metadata comes ONLY from the client-safe layer (which
// re-exports the canonical server registry) — never a duplicated table.
import {
    USDC_CONTRACT,
    USDC_DECIMALS,
    isCctpSupported,
    normalizeClientSymbol,
    resolveClientToken,
    shortTokenAddress,
} from '@/src/lib/tokens/clientTokens';
import { arcTestnet } from '@/src/lib/wagmi';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import { dedupeConnectors, friendlyConnectorLabel, hasInjectedProvider, isMobileViewport, withTimeout } from '@/lib/wallet/walletLabels';

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
    /**
     * Canonical settlement-token identity resolved from the payment record
     * (multicurrency Phase 1 read-model + Phase 2A settlement). Legacy rows
     * resolve to USDC.
     *
     * Phase 2A: handlePayment below transfers via `token.address` /
     * `token.decimals` (falling back to USDC_CONTRACT/USDC_DECIMALS for
     * legacy rows without token identity), and verify-onchain matches the
     * Transfer log against the same resolved token — so an EURC invoice
     * moves and verifies EURC, never USDC.
     */
    token?: { symbol: string; address: string; decimals: number } | null;
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

const CONNECT_TIMEOUT_MS = 45000;

// Minimal balanceOf fragment for the payer-balance display. Read-only, no
// signing — the transfer itself still uses erc20TransferAbi above.
const erc20BalanceAbi = [
    {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const;

function friendlyConnectError(err: unknown): string {
    return friendlyWalletError(err);
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

    const { address, isConnected, connector: activeConnector } = useAccount();
    const { connectors, connect, connectAsync, error: connectError, isPending: isConnecting, reset: resetConnect } = useConnect();
    const { disconnect } = useDisconnect();
    const { writeContractAsync } = useWriteContract();
    const chainId = useChainId();
    const { switchChainAsync } = useSwitchChain();
    const [networkMismatch, setNetworkMismatch] = useState(false);
    const [showTechnical, setShowTechnical] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [switching, setSwitching] = useState(false);

    // ── Phase 2B: invoice token identity (authoritative, never converted) ──
    // The invoice's token drives EVERYTHING below: the displayed symbol, the
    // balance read, and CCTP availability. Legacy rows without token identity
    // resolve to USDC. `normalizeClientSymbol` never guesses — unknown input
    // falls back to USDC for display only; the actual transfer still uses the
    // server-resolved `payment.token` with the same USDC fallback.
    const invoiceSymbol = normalizeClientSymbol(payment?.currency ?? payment?.token?.symbol ?? null) ?? 'USDC';
    const invoiceToken = resolveClientToken({ currency: payment?.currency, token: payment?.token });
    const isEurc = invoiceSymbol === 'EURC';
    // CCTP is intentionally USDC-only: no EURC CCTP mechanism exists in this
    // repo, so the cross-chain tab is unavailable for EURC invoices (they
    // settle via the wallet tab's same-chain transfer instead).
    const cctpAvailable = isCctpSupported(invoiceSymbol);

    // Display/balance read against the invoice token contract (same address
    // the transfer below signs; USDC fallback for legacy rows). handlePayment
    // keeps its own Phase 2A locals — identical expression, non-null payment.
    const invoiceTransferAddress = (payment?.token?.address || USDC_CONTRACT) as `0x${string}`;
    const invoiceTransferDecimals = payment?.token?.decimals ?? USDC_DECIMALS;

    // Payer balance in the INVOICE token (not whatever token happens to be
    // highest) — read-only balanceOf against the same contract the transfer
    // will sign. Never blocks payment when unreadable (RPC hiccup); it only
    // powers the display + the insufficient-balance warning below.
    const { data: tokenBalanceRaw, isLoading: isBalanceLoading } = useReadContract({
        address: invoiceTransferAddress,
        abi: erc20BalanceAbi,
        functionName: 'balanceOf',
        args: [(address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`],
        query: { enabled: isConnected && !!address && !!payment && payment.status !== 'SUCCESS' },
    });
    let payerTokenBalance: number | null = null;
    try {
        if (typeof tokenBalanceRaw === 'bigint') {
            payerTokenBalance = Number(formatUnits(tokenBalanceRaw, invoiceTransferDecimals));
        }
    } catch { /* unparseable balance — display nothing, block nothing */ }
    const hasInsufficientBalance =
        payerTokenBalance !== null &&
        !!payment &&
        payment.status !== 'SUCCESS' &&
        payerTokenBalance < Number(payment.amount);

    // CCTP is unavailable for EURC: never leave the widget sitting on the
    // cross-chain tab for an invoice it cannot settle.
    useEffect(() => {
        if (payment && !cctpAvailable && method === 'cctp') setMethod('wallet');
    }, [payment, cctpAvailable, method]);

    const fetchLedgerStatus = useCallback(async () => {
        if (!reference) return;
        try {
            // Hard timeout so a hung request can never leave this widget (or a
            // page waiting on its events) stuck in a loading state forever.
            const res = await fetch(`/api/payments/verify/${reference}`, { signal: AbortSignal.timeout(15000) });
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
                setError(result.message || 'We couldn\'t find this payment. Please check the link and try again.');
            }
        } catch {
            setError('We couldn\'t load this payment. Check your connection and try again.');
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
            setShowTechnical(false);
            // Pre-flight: the payer sees the shortfall BEFORE signing.
            // Names the invoice token explicitly — never a generic "funds" error.
            if (hasInsufficientBalance) {
                setIsTxPending(false);
                const msg = `Insufficient ${invoiceSymbol} balance for this payment. You need ${payment.amount} ${invoiceSymbol} but your wallet holds ${payerTokenBalance} ${invoiceSymbol}.`;
                setSettleError(msg);
                onEvent?.({ type: 'payment_error', error: msg });
                return;
            }
            setIsTxPending(true);
            onEvent?.({ type: 'payment_pending' });

            if (chainId !== arcTestnet.id) {
                const providerGetter = async () => {
                    try { return await (activeConnector as any)?.getProvider?.(); } catch { return null; }
                };
                const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: providerGetter });
                if (!net.ok) {
                    setIsTxPending(false);
                    setNetworkMismatch(true);
                    setSettleError(net.message);
                    onEvent?.({ type: 'payment_error', error: net.message });
                    return;
                }
            }

            // Phase 2A token-native transfer: the ERC-20 contract and decimals
            // come from the server-resolved invoice token (USDC invoices move
            // USDC, EURC invoices move EURC), falling back to the USDC
            // constants only for legacy rows without token identity. The
            // server re-resolves and enforces the same token in
            // verify-onchain, so a mismatched transfer can never settle.
            const transferAddress = (payment.token?.address || USDC_CONTRACT) as `0x${string}`;
            const transferDecimals = payment.token?.decimals ?? USDC_DECIMALS;
            const txHash = await writeContractAsync({
                address: transferAddress,
                abi: erc20TransferAbi,
                functionName: 'transfer',
                args: [payment.merchantSCA as `0x${string}`, parseUnits(payment.amount.toString(), transferDecimals)],
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
            const msg = friendlyWalletError(err);
            // Map common tx rejections to friendly copy that names the invoice
            // token — the user must know WHICH balance is short, never a bare
            // "insufficient funds".
            const lower = String((err as any)?.shortMessage ?? (err as any)?.message ?? '').toLowerCase();
            const friendly = lower.includes('user rejected') || lower.includes('user denied')
                ? 'Payment cancelled. No funds were moved.'
                : lower.includes('insufficient') || lower.includes('out of funds') || lower.includes('outoffunds') || lower.includes('gas required exceeds allowance') ? `Insufficient ${invoiceSymbol} for this transaction. You need ${payment?.amount} ${invoiceSymbol}.`
                : msg;
            setSettleError(friendly);
            onEvent?.({ type: 'payment_error', error: friendly });
        }
    };

    const handleCctpVerify = async () => {
        if (!reference || !cctpTxHash.trim()) return;
        // Defensive: the tab is unavailable for EURC, but a stale method state
        // must never smuggle a cross-chain settlement onto a non-USDC invoice.
        if (!cctpAvailable) {
            const msg = `Cross-chain (CCTP) settlement is USDC-only and cannot settle this ${invoiceSymbol} invoice — please use the wallet tab to pay in ${invoiceSymbol}.`;
            setCctpError(msg);
            onEvent?.({ type: 'payment_error', error: msg });
            return;
        }
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
                <p style={{ color: '#f87171', fontWeight: 700, marginBottom: 8, fontSize: 16 }}>Payment unavailable</p>
                <p style={{ color: '#6b5a45', fontSize: 12 }}>{error || 'We couldn\'t find this payment. Please check the link and try again.'}</p>
            </div>
        );
    }

    const isConfirmed = payment.status === 'SUCCESS';
    // NOTE: `isEurc` is derived from the invoice token near the top of this
    // component (currency OR server-resolved token symbol) — no second
    // definition here.

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

            {/* Payment method tabs — "wallet" settles natively in the invoice
                token; CCTP is USDC-only so its tab is unavailable for EURC
                invoices (disabled, auto-switched to wallet above). */}
            {PAYMENT_METHODS.length > 1 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 18, borderBottom: '1px solid #2d2015', paddingBottom: 12 }}>
                    {PAYMENT_METHODS.map((m) => {
                        const tabAvailable = m.available && (m.key !== 'cctp' || cctpAvailable);
                        return (
                            <button
                                key={m.key}
                                onClick={() => tabAvailable && setMethod(m.key)}
                                disabled={!tabAvailable}
                                title={!tabAvailable ? (m.key === 'cctp' ? 'Cross-chain (CCTP) is USDC-only' : 'Coming soon') : undefined}
                                style={{
                                    padding: '6px 12px',
                                    borderRadius: 8,
                                    border: 'none',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: tabAvailable ? 'pointer' : 'not-allowed',
                                    background: method === m.key ? 'rgba(200,151,90,0.15)' : 'transparent',
                                    color: method === m.key ? '#c8975a' : tabAvailable ? '#6b5a45' : '#3d332a',
                                }}
                            >
                                {m.label}{m.key === 'cctp' && !cctpAvailable ? ' (USDC-only)' : (!tabAvailable && ' (soon)')}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Phase 2B: token identity is always explicit — the user sees
                exactly which token they are about to sign BEFORE signing.
                USDC and EURC both settle natively on Arc Testnet; the transfer
                below signs the invoice token and verify-onchain enforces it. */}
            {!isConfirmed && (
                <div style={{ background: isEurc ? 'rgba(6,182,212,0.06)' : 'rgba(200,151,90,0.06)', border: `1px solid ${isEurc ? 'rgba(6,182,212,0.2)' : 'rgba(200,151,90,0.25)'}`, borderRadius: 12, padding: 12, marginBottom: 16, textAlign: 'center' }}>
                    <p style={{ color: isEurc ? '#06b6d4' : '#c8975a', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Paying in {invoiceSymbol}</p>
                    <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>
                        This invoice settles in {invoiceSymbol} on Arc Testnet ({shortTokenAddress(invoiceToken.address)}).
                        Your wallet will submit {isEurc ? 'an' : 'a'} {invoiceSymbol} transfer of {payment.amount} {invoiceSymbol}, verified on-chain before confirmation.
                    </p>
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
                    // Amount display ALWAYS carries its symbol — the UI must
                    // never say EURC while the transfer signs USDC (or vice
                    // versa). The symbol here is the invoice token, identical
                    // to the transfer contract above.
                    { label: 'Amount Due', value: payment.amount.toString(), highlight: true },
                    { label: 'Token', value: `${invoiceSymbol} · ${shortTokenAddress(invoiceToken.address)}` },
                ].map((row, i) => (
                    <div key={i} style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <span style={{ color: '#6b5a45', fontSize: 12 }}>{row.label}</span>
                        <span style={{ fontSize: row.highlight ? 18 : 12, fontWeight: row.highlight ? 800 : 500, color: '#f0ece6', fontFamily: row.mono ? 'monospace' : 'inherit' }}>
                            {row.truncate && row.value.length > 20 ? `${row.value.slice(0, 20)}...` : row.value}
                            {row.highlight && <span style={{ color: '#c8975a', fontSize: 12, marginLeft: 6 }}>{invoiceSymbol}</span>}
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
                                const hasProvider = hasInjectedProvider();
                                const isMobile = isMobileViewport();
                                const showInjected = !(isMobile && !hasProvider);
                                const deduped = dedupeConnectors(connectors);
                                const injectedConnectors = deduped.filter((c) => c.type === 'injected');
                                const walletConnectConnector = deduped.find((c) => c.type === 'walletConnect');
                                const otherConnectors = deduped.filter((c) => c.type !== 'injected' && c.type !== 'walletConnect');

                                const attemptConnect = async (c: (typeof connectors)[number]) => {
                                    resetConnect();
                                    if (connectAsync) {
                                        try {
                                            setConnecting(true);
                                            await withTimeout(connectAsync({ connector: c }), CONNECT_TIMEOUT_MS, 'Wallet connection timed out');
                                        } catch (err: any) {
                                            // friendly error handled via connectError + catch
                                        } finally { setConnecting(false); }
                                    } else {
                                        connect({ connector: c });
                                    }
                                };

                                const isBusy = connecting || isConnecting;

                                return (
                                    <>
                                        {showInjected &&
                                            injectedConnectors.map((c) => (
                                                <button
                                                    key={c.uid}
                                                    onClick={() => attemptConnect(c)}
                                                    disabled={isBusy}
                                                    style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: isBusy ? 'not-allowed' : 'pointer', background: '#251c12', color: '#f0ece6' }}
                                                >
                                                    {isBusy ? 'Connecting...' : `Connect ${friendlyConnectorLabel(c)}`}
                                                </button>
                                            ))}
                                        {walletConnectConnector && (
                                            <button
                                                key={walletConnectConnector.uid}
                                                onClick={() => attemptConnect(walletConnectConnector)}
                                                disabled={isBusy}
                                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: isBusy ? 'not-allowed' : 'pointer', background: '#251c12', color: '#f0ece6' }}
                                            >
                                                {isBusy ? 'Connecting...' : showInjected ? 'Connect with WalletConnect' : 'Connect Wallet'}
                                            </button>
                                        )}
                                        {otherConnectors.map((c) => (
                                            <button
                                                key={c.uid}
                                                onClick={() => attemptConnect(c)}
                                                disabled={isBusy}
                                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #3d2e1a', fontSize: 14, fontWeight: 700, cursor: isBusy ? 'not-allowed' : 'pointer', background: '#251c12', color: '#f0ece6' }}
                                            >
                                                {isBusy ? 'Connecting...' : `Connect ${friendlyConnectorLabel(c)}`}
                                            </button>
                                        ))}
                                        {isMobile && !hasProvider && walletConnectConnector && (
                                            <p style={{ color: '#6b5a45', fontSize: 11, margin: '4px 0 0', lineHeight: 1.4 }}>
                                                On mobile, open this page in your wallet app, or copy the link and open it there.
                                            </p>
                                        )}
                                        {isMobile && !hasProvider && !walletConnectConnector && (
                                            <p style={{ color: '#6b5a45', fontSize: 11, margin: '4px 0 0' }}>
                                                WalletConnect isn&apos;t configured. On mobile, open this page inside your wallet app&apos;s browser.
                                            </p>
                                        )}
                                    </>
                                );
                            })()}
                            {connectError && (
                                <p style={{ color: '#f87171', fontSize: 11, margin: '4px 0 0' }}>
                                    ⚠️ {friendlyConnectError(connectError)}
                                </p>
                            )}
                        </div>
                    ) : chainId !== arcTestnet.id ? (
                        <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#6b5a45' }}>
                                <span>Connected: {address?.slice(0, 6)}...{address?.slice(-4)}</span>
                                <button onClick={() => disconnect()} style={{ background: 'none', border: 'none', color: '#c8975a', cursor: 'pointer', fontSize: 'inherit' }}>
                                    Disconnect
                                </button>
                            </div>
                            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 12, padding: 12, marginBottom: 10, textAlign: 'center' }}>
                                <p style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Wrong network</p>
                                <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>This payment uses Arc Testnet. Switch your wallet to Arc to continue.</p>
                            </div>
                            <button
                                onClick={async () => {
                                    setSwitching(true);
                                    setNetworkMismatch(false);
                                    setSettleError(null);
                                    try {
                                        const getter = async () => { try { return await (activeConnector as any)?.getProvider?.(); } catch { return null; } };
                                        const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: getter });
                                        if (!net.ok) { setNetworkMismatch(true); setSettleError(net.message); }
                                    } catch (e: any) { setSettleError(friendlyWalletError(e)); setNetworkMismatch(true); }
                                    finally { setSwitching(false); }
                                }}
                                disabled={switching}
                                style={{ width: '100%', padding: 16, borderRadius: 14, border: '1px solid #c8975a', fontSize: 14, fontWeight: 800, cursor: switching ? 'not-allowed' : 'pointer', background: switching ? '#6b5a45' : 'transparent', color: '#c8975a' }}
                            >
                                {switching ? 'Switching...' : 'Switch to Arc Testnet'}
                            </button>
                            <p style={{ color: '#6b5a45', fontSize: 10, margin: '6px 0 0', textAlign: 'center' }}>Pay is blocked until Arc Testnet is selected — no “Pay anyway”.</p>
                        </>
                    ) : (
                        <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#6b5a45' }}>
                                <span>Connected: {address?.slice(0, 6)}...{address?.slice(-4)} · Arc Testnet ✓</span>
                                <button onClick={() => disconnect()} style={{ background: 'none', border: 'none', color: '#c8975a', cursor: 'pointer', fontSize: 'inherit' }}>
                                    Disconnect
                                </button>
                            </div>
                            <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: 10, fontSize: 11, color: '#6b5a45', textDecoration: 'underline' }}>
                                No test {invoiceSymbol}? Get some free ↗
                            </a>
                            {/* Correct-token balance: the payer sees THEIR balance
                                in the invoice token before signing — never a
                                different token's balance. */}
                            <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 12, padding: '10px 14px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ color: '#6b5a45', fontSize: 11 }}>Your {invoiceSymbol} balance</span>
                                <span style={{ color: '#f0ece6', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                                    {isBalanceLoading ? '…' : payerTokenBalance !== null ? `${payerTokenBalance} ${invoiceSymbol}` : 'unavailable'}
                                </span>
                            </div>
                            {hasInsufficientBalance && (
                                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 12, padding: 12, marginBottom: 10, textAlign: 'center' }}>
                                    <p style={{ color: '#f87171', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Insufficient {invoiceSymbol} balance</p>
                                    <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>
                                        You need {payment.amount} {invoiceSymbol} but your wallet holds {payerTokenBalance} {invoiceSymbol}. Top up {invoiceSymbol} before paying — a {invoiceSymbol === 'EURC' ? 'USDC' : 'EURC'} balance cannot pay this invoice.
                                    </p>
                                </div>
                            )}
                            <button
                                onClick={handlePayment}
                                disabled={isTxPending || isVerifying || isConfirmed || secondsLeft === 0 || hasInsufficientBalance}
                                style={{
                                    width: '100%',
                                    padding: 16,
                                    borderRadius: 14,
                                    border: 'none',
                                    fontSize: 14,
                                    fontWeight: 800,
                                    cursor: isConfirmed || secondsLeft === 0 || hasInsufficientBalance ? 'default' : isTxPending || isVerifying ? 'not-allowed' : 'pointer',
                                    background: isConfirmed ? 'rgba(6,182,212,0.1)' : isTxPending || isVerifying || hasInsufficientBalance ? '#6b5a45' : '#c8975a',
                                    color: isConfirmed ? '#06b6d4' : '#0e0b08',
                                }}
                            >
                                {isConfirmed ? '✓ Payment Confirmed' : isTxPending ? '⏳ Confirm in your wallet...' : isVerifying ? '🔍 Verifying on-chain...' : secondsLeft === 0 ? 'Link Expired' : hasInsufficientBalance ? `Insufficient ${invoiceSymbol} balance` : `Pay ${payment.amount} ${invoiceSymbol}`}
                            </button>
                        </>
                    )}
                </>
            )}

            {method === 'cctp' && cctpAvailable && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>
                        Send {payment.amount} {invoiceSymbol} from another chain using your own wallet, then paste the transaction hash below to verify and settle.
                    </p>
                    {/* CCTP is intentionally USDC-only (Phase 2A): no EURC CCTP
                        mechanism exists in this repo. EURC invoices use the
                        wallet tab's same-chain EURC transfer instead. The tab
                        above is unavailable for EURC and auto-switches to the
                        wallet method, so this panel only ever renders for USDC. */}
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
                        disabled={cctpSubmitting || isConfirmed || isEurc || !cctpTxHash.trim()}
                        style={{
                            width: '100%',
                            padding: 16,
                            borderRadius: 14,
                            border: 'none',
                            fontSize: 14,
                            fontWeight: 800,
                            cursor: cctpSubmitting || isConfirmed || isEurc || !cctpTxHash.trim() ? 'not-allowed' : 'pointer',
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

            {method === 'cctp' && !cctpAvailable && !isConfirmed && (
                <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
                    <p style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Cross-chain unavailable for {invoiceSymbol}</p>
                    <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>Cross-chain (CCTP) settlement is USDC-only and cannot settle this {invoiceSymbol} invoice.</p>
                </div>
            )}

            {settleError && (
                <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: 14, textAlign: 'center' }}>
                    <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>❌ {settleError}</p>
                </div>
            )}

            {networkMismatch && (
                <div style={{ marginTop: 12, background: '#1a1410', border: '1px solid #2d2015', borderRadius: 12, padding: 14 }}>
                    <p style={{ color: '#f0ece6', fontSize: 12, fontWeight: 600, margin: '0 0 6px', lineHeight: 1.5 }}>
                        FlareHQ uses <strong>Arc Testnet</strong> for this payment. Your wallet couldn&apos;t switch automatically. Open your wallet
                        and select/add <strong>Arc Testnet</strong>, then return here and try again.
                    </p>
                    <button
                        onClick={() => setShowTechnical((v) => !v)}
                        style={{ background: 'none', border: 'none', color: '#c8975a', cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}
                    >
                        {showTechnical ? 'Hide technical details' : 'Show technical details'}
                    </button>
                    {showTechnical && (
                        <div style={{ marginTop: 10 }}>
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
                </div>
            )}

            {isConfirmed && (
                <div style={{ marginTop: 16, background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 14, padding: 16, textAlign: 'center' }}>
                    <p style={{ color: '#06b6d4', fontWeight: 700, fontSize: 13, margin: '0 0 4px' }}>✓ Payment settled on Arc Testnet in {invoiceSymbol}</p>
                    <p style={{ color: '#4b4035', fontSize: 10, margin: 0 }}>Ledger updated · {payment.amount} {invoiceSymbol} confirmed on-chain · Dashboard synced</p>
                </div>
            )}
        </div>
    );
}
