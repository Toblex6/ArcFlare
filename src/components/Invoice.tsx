// src/components/Invoice.tsx
//
// Post-payment invoice display. Extracted as its own component (same
// reasoning as CheckoutWidget's extraction) so it can be reused anywhere a
// settled payment needs to be shown as an invoice later — a merchant-side
// "view invoice" page, an emailed link, etc. — without duplicating markup.
//
// DELIBERATE OMISSIONS — not oversights:
//   - No tax/discount rows: no such field exists anywhere in the schema or
//     the payment-link creation flow. Rendering a permanent $0.00 row would
//     misrepresent capability that doesn't exist.
//   - No itemized line items: PaymentLog is a single amount, not an
//     itemized order. One real line is shown ("Payment" × 1 @ amount), not
//     a fabricated multi-item breakdown.
//   - "Payer" instead of "Customer Information": only a wallet
//     address/email exists (PaymentLog.senderEmail). No name, no address.
//   - No merchant logo: Merchant has no logo/branding field. An
//     initials-based badge is used instead — an honest visual treatment,
//     not a fake uploaded image.

'use client';

import React, { useState } from 'react';

export interface InvoiceData {
    reference: string;
    amount: number;
    currency: string;
    chain: string;
    status: string;
    merchant: string | null;
    sender_email: string | null;
    arcTxHash: string | null;
    issuedAt: string | null;
    settledAt: string | null;
    expiresAt: string | null;
    explorerUrl: string; // caller builds this (page already has arcTestnet's block explorer base) — keeps this component chain-agnostic
    /** Canonical settlement-token identity when the caller has it (verify API
        returns it; legacy rows read as USDC). Display-only: amount + currency
        remain the record of what moved. */
    token?: { symbol: string; address: string; decimals: number } | null;
}

interface InvoiceProps {
    payment: InvoiceData;
    /** Real, working href for the merchant's site to link back to — only rendered when the caller has one. */
    returnUrl?: string | null;
}

function initials(name: string | null): string {
    if (!name) return 'FH';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'FH';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatDate(iso: string | null): string | null {
    if (!iso) return null;
    try {
        return new Date(iso).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return null;
    }
}

export default function Invoice({ payment, returnUrl }: InvoiceProps) {
    const [copied, setCopied] = useState(false);
    const isPaid = payment.status === 'SUCCESS';

    const copyTxHash = () => {
        if (!payment.arcTxHash) return;
        navigator.clipboard.writeText(payment.arcTxHash);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const downloadReceipt = () => {
        const lines = [
            'FLAREHQ — PAYMENT RECEIPT',
            '================================',
            `Reference:      ${payment.reference}`,
            `Merchant:       ${payment.merchant || 'FlareHQ Merchant'}`,
            `Status:         ${isPaid ? 'PAID' : payment.status}`,
            `Amount:         ${payment.amount} ${payment.currency}`,
            `Token:          ${payment.token?.symbol || payment.currency}${payment.token?.address ? ` (${payment.token.address})` : ''}`,
            `Network:        ${payment.chain}`,
            payment.issuedAt ? `Issued:         ${formatDate(payment.issuedAt)}` : null,
            isPaid && payment.settledAt ? `Settled:        ${formatDate(payment.settledAt)}` : null,
            payment.sender_email ? `Payer:          ${payment.sender_email}` : null,
            payment.arcTxHash ? `Transaction:    ${payment.arcTxHash}` : null,
            payment.arcTxHash ? `Explorer:       ${payment.explorerUrl}` : null,
            '================================',
            'This receipt reflects on-chain settlement data recorded by FlareHQ.',
        ].filter(Boolean);

        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `receipt-${payment.reference}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const downloadPdf = () => {
        window.print();
    };

    return (
        <div id="invoice-printable">
            {/* Print stylesheet — scoped to this component's id so window.print()
          produces a clean single-document PDF via the browser's native
          print-to-PDF, with no new dependency. */}
            <style>{`
        @media print {
          body * { visibility: hidden; }
          #invoice-printable, #invoice-printable * { visibility: visible; }
          #invoice-printable { position: absolute; top: 0; left: 0; width: 100%; padding: 24px; }
          #invoice-printable .no-print { display: none !important; }
        }
      `}</style>

            <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(22px, 4vw, 32px)' }}>
                {/* Header: branding + paid badge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div
                            style={{
                                width: 44,
                                height: 44,
                                borderRadius: 12,
                                background: 'linear-gradient(135deg, #c8975a, #8a6a3f)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: '#0e0b08',
                                fontWeight: 800,
                                fontSize: 15,
                                flexShrink: 0,
                            }}
                            aria-hidden="true"
                        >
                            {initials(payment.merchant)}
                        </div>
                        <div>
                            <p style={{ fontSize: 15, fontWeight: 800, color: '#f0ece6', margin: 0 }}>{payment.merchant || 'FlareHQ Merchant'}</p>
                            <p style={{ fontSize: 11, color: '#6b5a45', margin: '2px 0 0' }}>Invoice #{payment.reference}</p>
                        </div>
                    </div>

                    <span
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 14px',
                            borderRadius: 20,
                            fontSize: 11,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            background: isPaid ? 'rgba(13,124,95,0.15)' : 'rgba(245,158,11,0.12)',
                            color: isPaid ? '#10b981' : '#f59e0b',
                            border: `1px solid ${isPaid ? 'rgba(13,124,95,0.35)' : 'rgba(245,158,11,0.3)'}`,
                            textTransform: 'uppercase',
                        }}
                    >
                        {isPaid ? '✓ Paid' : payment.status}
                    </span>
                </div>

                {/* Dates */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16, marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid #2d2015' }}>
                    <div>
                        <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 4px' }}>Issue Date</p>
                        <p style={{ fontSize: 12.5, color: '#f0ece6', margin: 0 }}>{formatDate(payment.issuedAt) || '—'}</p>
                    </div>
                    {!isPaid && payment.expiresAt && (
                        <div>
                            <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 4px' }}>Payment Due</p>
                            <p style={{ fontSize: 12.5, color: '#f0ece6', margin: 0 }}>{formatDate(payment.expiresAt) || '—'}</p>
                        </div>
                    )}
                    {isPaid && payment.settledAt && (
                        <div>
                            <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 4px' }}>Settled</p>
                            <p style={{ fontSize: 12.5, color: '#06b6d4', margin: 0 }}>{formatDate(payment.settledAt)}</p>
                        </div>
                    )}
                    <div>
                        <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 4px' }}>Payer</p>
                        <p style={{ fontSize: 11.5, color: '#f0ece6', margin: 0, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                            {payment.sender_email || '—'}
                        </p>
                    </div>
                </div>

                {/* Line items — single real line, no fabricated breakdown */}
                <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 12, padding: '0 0 10px', borderBottom: '1px solid #2d2015', fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        <span>Description</span>
                        <span>Qty</span>
                        <span>Unit Price</span>
                        <span>Amount</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 12, padding: '12px 0', alignItems: 'center' }}>
                        <span style={{ fontSize: 12.5, color: '#f0ece6' }}>Payment</span>
                        <span style={{ fontSize: 12.5, color: '#a89684' }}>1</span>
                        <span style={{ fontSize: 12.5, color: '#a89684' }}>{payment.amount} {payment.currency}</span>
                        <span style={{ fontSize: 12.5, color: '#f0ece6', fontWeight: 700 }}>{payment.amount} {payment.currency}</span>
                    </div>
                </div>

                {/* Totals — no tax/discount rows: neither field exists in the data model */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24, marginLeft: 'auto', maxWidth: 260 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: '#6b5a45' }}>Subtotal</span>
                        <span style={{ fontSize: 12, color: '#f0ece6' }}>{payment.amount} {payment.currency}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid #2d2015' }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: '#f0ece6' }}>Total</span>
                        <span style={{ fontSize: 16, fontWeight: 800, color: '#c8975a' }}>{payment.amount} {payment.currency}</span>
                    </div>
                </div>

                {/* Transaction details */}
                {payment.arcTxHash && (
                    <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 12, padding: '12px 14px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 0 }}>
                            <p style={{ fontSize: 9, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 3px' }}>Transaction Hash ({payment.token?.symbol || payment.currency} transfer)</p>
                            <p style={{ fontSize: 11, fontFamily: 'monospace', color: '#a89684', margin: 0, wordBreak: 'break-all' }}>{payment.arcTxHash}</p>
                        </div>
                        <div className="no-print" style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            <button
                                onClick={copyTxHash}
                                aria-label="Copy transaction hash"
                                style={{
                                    background: copied ? 'rgba(13,124,95,0.15)' : 'transparent',
                                    border: `1px solid ${copied ? '#0d7c5f' : '#3d2e1a'}`,
                                    borderRadius: 8,
                                    padding: '6px 12px',
                                    color: copied ? '#0d7c5f' : '#a89684',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                }}
                            >
                                {copied ? '✓ Copied' : 'Copy'}
                            </button>
                            <a
                                href={payment.explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                    border: '1px solid #3d2e1a',
                                    borderRadius: 8,
                                    padding: '6px 12px',
                                    color: '#a89684',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    textDecoration: 'none',
                                }}
                            >
                                Explorer ↗
                            </a>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="no-print" style={{ display: 'grid', gridTemplateColumns: returnUrl ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10 }}>
                    <button
                        onClick={downloadPdf}
                        title="Opens your browser's print dialog — choose 'Save as PDF'"
                        style={{ padding: '12px 0', borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                    >
                        Download PDF
                    </button>
                    <button
                        onClick={downloadReceipt}
                        style={{ padding: '12px 0', borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                    >
                        Download Receipt
                    </button>
                    {returnUrl && (
                        <a
                            href={returnUrl}
                            style={{ padding: '12px 0', borderRadius: 10, border: '1px solid #2d2015', background: 'transparent', color: '#6b5a45', fontSize: 12, fontWeight: 700, textAlign: 'center', textDecoration: 'none' }}
                        >
                            Return to Merchant
                        </a>
                    )}
                </div>
            </div>
        </div>
    );
}
