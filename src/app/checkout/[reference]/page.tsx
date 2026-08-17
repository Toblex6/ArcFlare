//src/app/checkout/[reference]/page.tsx
//
// Page-level chrome only — all payment logic, wallet connection, and
// on-chain verification stays in CheckoutWidget (unchanged). This file
// turns the widget's existing lifecycle events into a real payment
// timeline, and — once a payment settles — renders the same URL as a real
// invoice via the Invoice component, instead of a separate route.
//
// State machine (top to bottom, first match wins):
//   1. no payment yet, no error       -> CheckoutLoading (full page)
//   2. no payment yet, error          -> CheckoutError (full page) —
//      the reference never resolved at all, nothing for the widget to
//      retry against (distinct from a mid-flow settlement error, which
//      DOES have a payment object and stays in the normal timeline below
//      so the existing retry flow still works)
//   3. payment loaded, expired        -> CheckoutExpired (full page) —
//      paying is impossible, no reason to show the wallet-connect widget.
//      Confirmed: EXPIRED is a real status set server-side in
//      payments/settle/route.ts:224 when the expiry check fires at
//      settle time. The client-side expiresAt comparison below catches
//      the case for visitors who never attempt to settle (EXPIRED only
//      appears AFTER a settle attempt on an expired reference).
//   4. payment loaded, SUCCESS        -> Invoice (existing behavior,
//      unchanged) — this already IS the "already paid" view, richer than
//      a generic AlreadyPaid card, so CheckoutAlreadyPaid is intentionally
//      not used here (it IS used on the embed page, which has no room for
//      a full invoice).
//   5. everything else (PENDING, PROCESSING_ONCHAIN, SETTLEMENT_ERROR,
//      mid-flow errors) -> existing widget + timeline + order summary,
//      unchanged from before.
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
import { CheckoutLoading } from '@/src/components/checkout/CheckoutLoading';
import { CheckoutExpired } from '@/src/components/checkout/CheckoutExpired';
import { CheckoutError } from '@/src/components/checkout/CheckoutError';

type Phase = 'awaiting' | 'wallet_connected' | 'confirming' | 'settled';

const PHASE_ORDER: Phase[] = ['awaiting', 'wallet_connected', 'confirming', 'settled'];

const STEPS: { key: Phase; label: string; description: string }[] = [
  { key: 'awaiting', label: 'Awaiting Payment', description: 'Connect a wallet to begin.' },
  { key: 'wallet_connected', label: 'Wallet Connected', description: 'Ready to send payment.' },
  { key: 'confirming', label: 'Confirming Payment', description: "Follow your wallet's prompts, then wait for on-chain confirmation." },
  { key: 'settled', label: 'Settled', description: 'Payment confirmed on Arc Testnet.' },
];

type StepStatus = 'complete' | 'active' | 'upcoming' | 'error';

type EnrichedPayment = PaymentLogData & {
  issuedAt?: string | null;
  settledAt?: string | null;
  expiresAt?: string | null;
};

function isPaymentExpired(payment: EnrichedPayment | null): boolean {
  if (!payment) return false;
  if ((payment as any).status === 'EXPIRED') return true;
  if (payment.status === 'PENDING' && payment.expiresAt) {
    const expiry = new Date(payment.expiresAt).getTime();
    if (!Number.isNaN(expiry) && Date.now() > expiry) return true;
  }
  return false;
}

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

  if (!payment && hasError) {
    return (
      <main
        style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        <CheckoutError reference={reference} message={errorMessage} />
      </main>
    );
  }

  if (!payment && !hasError) {
    return (
      <main
        style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        <CheckoutLoading reference={reference} />
      </main>
    );
  }

  if (isPaymentExpired(payment)) {
    return (
      <main
        style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        <CheckoutExpired
          reference={payment!.reference}
          amount={payment!.amount}
          currency={payment!.currency}
          merchantName={payment!.merchant_username ? `@${payment!.merchant_username}` : payment!.merchant}
          expiresAt={payment!.expiresAt}
        />
      </main>
    );
  }

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
        <div className="no-print">
          <CheckoutWidget reference={reference} onEvent={handleEvent} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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

          {!isConfirmed && payment && (
            <div className="no-print" style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(20px, 3vw, 24px)' }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, color: '#f0ece6', margin: '0 0 14px' }}>Order Summary</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#6b5a45', fontSize: 12 }}>Merchant</span>
                  <span style={{ color: '#f0ece6', fontSize: 12 }}>{payment.merchant_username ? `@${payment.merchant_username}` : (payment.merchant || 'FlareHQ Merchant')}</span>
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

          {isConfirmed && invoiceData && <Invoice payment={invoiceData} returnUrl={referrer} />}
        </div>
      </div>
    </main>
  );
}
