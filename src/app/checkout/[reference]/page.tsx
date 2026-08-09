//src/app/checkout/[reference]/page.tsx
//
// Page-level chrome only — all payment logic, wallet connection, and
// on-chain verification stays in CheckoutWidget (unchanged). This file
// turns the widget's existing lifecycle events into a real payment
// timeline, and — once a payment settles — renders the same URL as a real
// invoice via the Invoice component, instead of a separate route. That's
// the "automatically becomes an invoice page" behavior: no new page, no
// new flow, just a different branch of the same component tree.
//
// Honesty notes (carried over from the timeline pass, still true here):
//   - payment_pending covers both "wallet is signing" and "verifying
//     on-chain" — the widget doesn't distinguish them, so neither does this
//     page. One truthful "Confirming Payment" step, not two fabricated ones.
//   - Invoice.tsx documents its own omissions (no tax/discount/line-items/
//     customer name — none of that exists in the data model).

'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { arcTestnet } from '@/src/lib/wagmi';
import CheckoutWidget, { PaymentLogData, CheckoutEvent } from '@/src/components/CheckoutWidget';
import Invoice, { InvoiceData } from '@/src/components/Invoice';

type Phase = 'awaiting' | 'wallet_connected' | 'confirming' | 'settled';

const PHASE_ORDER: Phase[] = ['awaiting', 'wallet_connected', 'confirming', 'settled'];

const STEPS: { key: Phase; label: string; description: string }[] = [
  { key: 'awaiting', label: 'Awaiting Payment', description: 'Connect a wallet to begin.' },
  { key: 'wallet_connected', label: 'Wallet Connected', description: 'Ready to send payment.' },
  { key: 'confirming', label: 'Confirming Payment', description: "Follow your wallet's prompts, then wait for on-chain confirmation." },
  { key: 'settled', label: 'Settled', description: 'Payment confirmed on Arc Testnet.' },
];

type StepStatus = 'complete' | 'active' | 'upcoming' | 'error';

// The verify endpoint now returns issuedAt/settledAt/expiresAt alongside
// the fields CheckoutWidget's PaymentLogData already knows about (see
// verify/[reference]/route.ts's additive formatResponse change). Widening
// the type here — not touching CheckoutWidget.tsx — is a TS-only change;
// the extra fields are already present on the real JSON payload at runtime.
type EnrichedPayment = PaymentLogData & {
  issuedAt?: string | null;
  settledAt?: string | null;
  expiresAt?: string | null;
};

export default function CheckoutPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference;

  const [payment, setPayment] = useState<EnrichedPayment | null>(null);
  const [phase, setPhase] = useState<Phase>('awaiting');
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [referrer, setReferrer] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document !== 'undefined' && document.referrer) {
      try {
        const ref = new URL(document.referrer);
        if (ref.origin !== window.location.origin) setReferrer(document.referrer);
      } catch {
        // malformed referrer — ignore, no return-to-merchant action shown
      }
    }
  }, []);

  const handleEvent = (event: CheckoutEvent) => {
    switch (event.type) {
      case 'status':
        setPayment(event.payment as EnrichedPayment);
        if (event.payment.status === 'SUCCESS') setPhase('settled');
        break;
      case 'wallet_connected':
        setHasError(false);
        setPhase((p) => (p === 'awaiting' ? 'wallet_connected' : p));
        break;
      case 'payment_pending':
        setHasError(false);
        setErrorMessage(null);
        setPhase('confirming');
        break;
      case 'payment_success':
        setHasError(false);
        setPayment(event.payment as EnrichedPayment);
        setPhase('settled');
        break;
      case 'payment_error':
        setHasError(true);
        setErrorMessage(event.error);
        break;
    }
  };

  if (!reference) return null;

  const isConfirmed = payment?.status === 'SUCCESS';
  const phaseIndex = PHASE_ORDER.indexOf(phase);

  const stepStatus = (stepKey: Phase): StepStatus => {
    const stepIndex = PHASE_ORDER.indexOf(stepKey);
    if (hasError && stepIndex === phaseIndex) return 'error';
    if (stepIndex < phaseIndex) return 'complete';
    if (stepIndex === phaseIndex) return 'active';
    return 'upcoming';
  };

  const invoiceData: InvoiceData | null = payment
    ? {
      reference: payment.reference,
      amount: payment.amount,
      currency: payment.currency,
      chain: payment.chain,
      status: payment.status,
      merchant: payment.merchant,
      sender_email: payment.sender_email,
      arcTxHash: payment.arcTxHash,
      issuedAt: payment.issuedAt ?? payment.paid_at ?? null,
      settledAt: payment.settledAt ?? null,
      expiresAt: payment.expiresAt ?? null,
      explorerUrl: payment.arcTxHash
        ? `${arcTestnet.blockExplorers.default.url}/tx/${payment.arcTxHash}`
        : arcTestnet.blockExplorers.default.url,
    }
    : null;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0e0b08',
        color: '#f0ece6',
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: 'clamp(16px, 3vw, 32px) clamp(12px, 2vw, 24px)',
      }}
    >
      {/* Header */}
      <div
        className="no-print"
        style={{
          maxWidth: 1160,
          margin: '0 auto 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={40} height={40} style={{ borderRadius: 10, objectFit: 'contain' }} />
          <div>
            <p style={{ color: '#f0ece6', fontSize: 'clamp(14px, 2vw, 17px)', fontWeight: 700, margin: 0, letterSpacing: -0.3 }}>FLAREHQ</p>
            <p style={{ color: '#6b5a45', fontSize: 'clamp(10px, 1vw, 11px)', margin: 0 }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>

        {/* Trust indicators — truthful, no fabricated claims */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {[
            { label: 'Non-custodial', dot: '#06b6d4' },
            { label: payment?.chain || 'Arc Testnet', dot: '#c8975a' },
            { label: 'On-chain verified', dot: '#0d7c5f' },
          ].map((badge) => (
            <div
              key={badge.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: '#1a1410',
                border: '1px solid #2d2015',
                borderRadius: 20,
                padding: '6px 12px',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: badge.dot, display: 'inline-block' }} />
              <span style={{ fontSize: 10, color: '#a89684', fontWeight: 600, fontFamily: 'monospace', letterSpacing: 0.5 }}>
                {badge.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Main Grid */}
      <div
        style={{
          maxWidth: 1160,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 'clamp(16px, 2vw, 24px)',
          alignItems: 'start',
        }}
      >
        {/* LEFT — the reusable widget, untouched. Hidden on print — the
            wallet-connect/CCTP UI has no place on a printed invoice. */}
        <div className="no-print">
          <CheckoutWidget reference={reference} onEvent={handleEvent} />
        </div>

        {/* RIGHT — timeline (pre-payment) or full invoice (post-payment) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Payment Timeline — hidden once settled since the Invoice below
              fully supersedes it visually. */}
          {!isConfirmed && (
            <div
              className="no-print"
              style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(20px, 3vw, 28px)' }}
              role="status"
              aria-live="polite"
              aria-label="Payment progress"
            >
              <h3 style={{ fontSize: 'clamp(16px, 2vw, 18px)', fontWeight: 700, color: '#f0ece6', margin: '0 0 20px' }}>
                Payment Progress
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {STEPS.map((step, i) => {
                  const status = stepStatus(step.key);
                  const isLast = i === STEPS.length - 1;
                  const dotColor =
                    status === 'complete' ? '#0d7c5f' : status === 'active' ? '#c8975a' : status === 'error' ? '#dc2626' : '#3d2e1a';
                  const textColor = status === 'upcoming' ? '#4b4035' : '#f0ece6';

                  return (
                    <div key={step.key} style={{ display: 'flex', gap: 14 }} aria-current={status === 'active' ? 'step' : undefined}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            background: status === 'upcoming' ? 'transparent' : dotColor,
                            border: `2px solid ${dotColor}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            transition: 'background 0.2s, border-color 0.2s',
                          }}
                        >
                          {status === 'complete' && <span style={{ color: '#0e0b08', fontSize: 11, fontWeight: 900 }}>✓</span>}
                          {status === 'active' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0e0b08' }} />}
                          {status === 'error' && <span style={{ color: '#fff', fontSize: 11, fontWeight: 900 }}>!</span>}
                        </div>
                        {!isLast && (
                          <div
                            style={{
                              width: 2,
                              flex: 1,
                              minHeight: 28,
                              background: status === 'complete' ? '#0d7c5f' : '#2d2015',
                              marginTop: 2,
                              marginBottom: 2,
                            }}
                          />
                        )}
                      </div>

                      <div style={{ paddingBottom: isLast ? 0 : 20 }}>
                        <p style={{ fontSize: 13, fontWeight: 700, color: textColor, margin: '1px 0 2px' }}>
                          {step.label}
                          {status === 'active' && (
                            <span style={{ color: '#c8975a', fontWeight: 500, marginLeft: 8, fontSize: 11 }}>In progress...</span>
                          )}
                          {status === 'error' && (
                            <span style={{ color: '#f87171', fontWeight: 500, marginLeft: 8, fontSize: 11 }}>Failed — try again</span>
                          )}
                        </p>
                        <p style={{ fontSize: 11.5, color: status === 'upcoming' ? '#3d332a' : '#6b5a45', margin: 0, lineHeight: 1.5 }}>
                          {status === 'error' && errorMessage ? errorMessage : step.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pre-payment order summary */}
          {!isConfirmed && payment && (
            <div className="no-print" style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(20px, 3vw, 24px)' }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, color: '#f0ece6', margin: '0 0 14px' }}>Order Summary</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#6b5a45', fontSize: 12 }}>Merchant</span>
                  <span style={{ color: '#f0ece6', fontSize: 12 }}>{payment.merchant || 'FlareHQ Merchant'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#6b5a45', fontSize: 12 }}>Reference</span>
                  <span style={{ color: '#f0ece6', fontSize: 11, fontFamily: 'monospace' }}>{payment.reference}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid #2d2015' }}>
                  <span style={{ color: '#6b5a45', fontSize: 12 }}>Amount Due</span>
                  <span style={{ color: '#f0ece6', fontSize: 15, fontWeight: 800 }}>
                    {payment.amount} <span style={{ color: '#c8975a', fontSize: 12 }}>{payment.currency}</span>
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Post-payment — the page becomes an invoice */}
          {isConfirmed && invoiceData && <Invoice payment={invoiceData} returnUrl={referrer} />}
        </div>
      </div>
    </main>
  );
}
