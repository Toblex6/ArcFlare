//src/app/checkout/[reference]/page.tsx
//
// Refactored to use the shared CheckoutWidget for the actual payment form
// (wallet connect, QR, pay button) — this page now only owns the full-page
// chrome (header, two-column layout) and its own "Payment Status" side
// panel, driven by state lifted from the widget via onEvent.

'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { arcTestnet } from '@/src/lib/wagmi';
import CheckoutWidget, { PaymentLogData, CheckoutEvent } from '@/src/components/CheckoutWidget';

export default function CheckoutPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference;

  const [payment, setPayment] = useState<PaymentLogData | null>(null);
  const [processing, setProcessing] = useState(false);

  const handleEvent = (event: CheckoutEvent) => {
    if (event.type === 'status' || event.type === 'payment_success') {
      setPayment(event.payment);
    }
    if (event.type === 'payment_pending') setProcessing(true);
    if (event.type === 'payment_success' || event.type === 'payment_error') setProcessing(false);
  };

  if (!reference) return null;

  const isConfirmed = payment?.status === 'SUCCESS';

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
          <span style={{ fontSize: 'clamp(8px, 0.8vw, 10px)', color: '#06b6d4', fontWeight: 600, fontFamily: 'monospace', letterSpacing: 1 }}>SECURE CHECKOUT</span>
        </div>
      </div>

      {/* Main Grid */}
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'clamp(16px, 2vw, 24px)' }}>
        {/* LEFT — the reusable widget */}
        <CheckoutWidget reference={reference} onEvent={handleEvent} />

        {/* RIGHT — page-specific status panel, unchanged from before */}
        <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 24, padding: 'clamp(20px, 3vw, 32px)', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h3 style={{ fontSize: 'clamp(18px, 2.5vw, 24px)', fontWeight: 700, color: '#f0ece6', margin: 0 }}>Payment Status</h3>

          <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)' }}>
            <p style={{ color: '#6b5a45', fontSize: 'clamp(9px, 0.8vw, 11px)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Status</p>
            <p style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 800, color: isConfirmed ? '#06b6d4' : processing ? '#c8975a' : '#f59e0b', margin: 0 }}>
              {isConfirmed ? 'Payment Confirmed' : processing ? 'Processing' : 'Awaiting Payment'}
            </p>
          </div>

          {payment && (
            <div style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)', flex: 1 }}>
              <h4 style={{ fontSize: 'clamp(13px, 1.2vw, 15px)', fontWeight: 700, color: '#f0ece6', margin: '0 0 16px' }}>Transaction Details</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  <span style={{ color: '#6b5a45', fontSize: 'clamp(10px, 0.9vw, 12px)' }}>
                    {isConfirmed ? 'Settled Block Time' : 'Reference'}
                  </span>
                  <span style={{ color: isConfirmed ? '#06b6d4' : '#f0ece6', fontSize: 'clamp(9px, 0.8vw, 11px)', fontFamily: 'monospace' }}>
                    {isConfirmed && payment.paid_at ? new Date(payment.paid_at).toLocaleString() : payment.reference}
                  </span>
                </div>
              </div>
            </div>
          )}

          {isConfirmed && (
            <div style={{ background: 'rgba(13,124,95,0.1)', border: '1px solid rgba(13,124,95,0.25)', borderRadius: 14, padding: 16, textAlign: 'center' }}>
              <p style={{ fontSize: 'clamp(11px, 1vw, 13px)', color: '#0d7c5f', fontWeight: 700, margin: '0 0 4px' }}>✓ Payment received</p>
              <p style={{ fontSize: 'clamp(10px, 0.9vw, 12px)', color: '#4b5563', margin: '0 0 10px' }}>Settled automatically — no action needed from the merchant.</p>
              {payment.arcTxHash && (
                <details style={{ textAlign: 'left' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 'clamp(9px, 0.8vw, 11px)', color: '#6b5a45', userSelect: 'none' }}>
                    View technical details
                  </summary>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'clamp(9px, 0.8vw, 11px)' }}>
                      <span style={{ color: '#6b5a45' }}>Network</span>
                      <span style={{ color: '#f0ece6', fontFamily: 'monospace' }}>{payment.chain}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'clamp(9px, 0.8vw, 11px)' }}>
                      <span style={{ color: '#6b5a45' }}>Transaction ID</span>
                      <a
                        href={`${arcTestnet.blockExplorers.default.url}/tx/${payment.arcTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#06b6d4', fontFamily: 'monospace', textDecoration: 'underline' }}
                      >
                        {payment.arcTxHash.slice(0, 10)}...{payment.arcTxHash.slice(-6)}
                      </a>
                    </div>
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
