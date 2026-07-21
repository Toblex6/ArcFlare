'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { PaymentLog } from '@prisma/client';

function CheckoutHubPageContent() {
  const searchParams = useSearchParams();
  const paymentId = searchParams.get('id');
  const router = useRouter();
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentLog | null>(null);
  const [isLoadingPayment, setIsLoadingPayment] = useState(false);

  const handleLaunchTestnetSession = async () => {
    setIsInitializing(true);
    setError(null);
    try {
      const res = await fetch('/api/payments/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 0.1,
          currency: 'USDC',
          email: 'demo-user@flarehq.network',
          merchant: 'Dispatch Marketplace',
        }),
      });
      const result = await res.json();
      if (result.success && result.checkoutUrl) {
        router.push(result.checkoutUrl);
      } else {
        setError(result.error || 'Ledger rejected context token generation.');
      }
    } catch {
      setError('Unable to initialize connection with FlareHQ Gateway.');
    } finally {
      setIsInitializing(false);
    }
  };

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const fetchPaymentDetails = async () => {
      if (!paymentId) return;
      setIsLoadingPayment(true);
      try {
        const res = await fetch(`/api/payments?id=${paymentId}`);
        const result = await res.json();
        if (result.success && result.payment) {
          setPayment(result.payment);
          if (result.payment.status === 'SETTLED' || result.payment.status === 'EXPIRED') {
            clearInterval(intervalId);
          }
        } else {
          setError(result.error || 'Failed to fetch payment details.');
        }
      } catch (err) {
        setError('Error fetching payment details.');
        console.error(err);
      } finally {
        setIsLoadingPayment(false);
      }
    };

    if (paymentId) {
      fetchPaymentDetails();
      intervalId = setInterval(fetchPaymentDetails, 5000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [paymentId]);

  if (paymentId && isLoadingPayment && !payment) {
    return (
      <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <p style={{ color: '#c8975a' }}>Loading payment details...</p>
      </main>
    );
  } else if (paymentId && payment) {
    return (
      <main style={{ minHeight: '100vh', background: '#050403', color: '#f0ece6', fontFamily: 'monospace', padding: 'clamp(20px, 5vw, 40px)' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', border: '1px dashed #2d2015', padding: 'clamp(16px, 3vw, 24px)', background: '#0e0b08' }}>
          <h2 style={{ color: '#c8975a', margin: '0 0 8px 0', fontSize: 'clamp(20px, 4vw, 28px)' }}>FLAREHQ HEADLESS HUB</h2>
          <p style={{ color: '#6b5a45', fontSize: 'clamp(10px, 1.2vw, 12px)', margin: '0 0 24px 0' }}>
            TARGET STATUS: {payment.status}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#050403', padding: 'clamp(12px, 2vw, 16px)', borderRadius: 8 }}>
            <p style={{ margin: 0, fontSize: 'clamp(12px, 1.2vw, 14px)' }}><strong>Recipient:</strong> {payment.merchant}</p>
            <p style={{ margin: 0, fontSize: 'clamp(12px, 1.2vw, 14px)' }}><strong>Invoice Ref:</strong> {payment.reference}</p>
            <p style={{ margin: 0, fontSize: 'clamp(12px, 1.2vw, 14px)' }}>
              <strong>Settle Requirements:</strong>{' '}
              <span style={{ color: '#00ffcc' }}>
                {payment.amount} {payment.currency}
              </span>
            </p>
            {payment.agentSCA && (
              <p style={{ margin: 0, fontSize: 'clamp(12px, 1.2vw, 14px)' }}><strong>Agent SCA:</strong> {payment.agentSCA}</p>
            )}
            {payment.arcTxHash && (
              <p style={{ margin: 0, fontSize: 'clamp(12px, 1.2vw, 14px)' }}><strong>Transaction Hash:</strong> {payment.arcTxHash}</p>
            )}
          </div>
          <p style={{ color: '#3d2e1a', fontSize: 'clamp(9px, 1vw, 11px)', marginTop: 24, textAlign: 'center' }}>
            MACHINE OPTIMIZED CONTENT NODE — NO HMI REQUIRED
          </p>
        </div>
      </main>
    );
  }

  // Default – no paymentId
  return (
    <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid #2d2015', padding: 'clamp(12px, 2vw, 24px) clamp(16px, 4vw, 48px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={40} height={40} style={{ borderRadius: 10, objectFit: 'contain' }} />
          <div>
            <p style={{ color: '#f0ece6', fontSize: 'clamp(14px, 2vw, 18px)', fontWeight: 700, margin: 0, letterSpacing: -0.3 }}>FLAREHQ</p>
            <p style={{ color: '#6b5a45', fontSize: 'clamp(8px, 0.8vw, 10px)', margin: 0, letterSpacing: 2, textTransform: 'uppercase', fontFamily: 'monospace' }}>Sandbox Environment</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#1a1410', border: '1px solid #2d2015', borderRadius: 20, padding: '6px 14px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#06b6d4', display: 'inline-block' }} />
          <span style={{ fontSize: 'clamp(8px, 0.8vw, 10px)', color: '#06b6d4', fontWeight: 600, fontFamily: 'monospace', letterSpacing: 1 }}>ROUTING NODE // ONLINE</span>
        </div>
      </header>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'clamp(24px, 5vw, 48px) clamp(16px, 3vw, 24px)' }}>
        <div style={{ width: '100%', maxWidth: 480 }}>
          <div style={{ background: '#1a1410', border: '1px solid #2d2015', borderRadius: 28, padding: 'clamp(24px, 5vw, 40px)', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={56} height={56} style={{ borderRadius: 14, objectFit: 'contain' }} />
              </div>
              <div style={{ display: 'inline-block', background: 'rgba(200,151,90,0.1)', border: '1px solid rgba(200,151,90,0.3)', borderRadius: 20, padding: '4px 14px', marginBottom: 16 }}>
                <span style={{ fontSize: 'clamp(9px, 1vw, 12px)', color: '#c8975a', fontFamily: 'monospace', letterSpacing: 2, textTransform: 'uppercase' }}>Arc Testnet v1.0</span>
              </div>
              <h2 style={{ fontSize: 'clamp(22px, 5vw, 32px)', fontWeight: 800, color: '#f0ece6', margin: '0 0 8px' }}>Developer Playbox</h2>
              <p style={{ color: '#6b5a45', fontSize: 'clamp(12px, 1.2vw, 14px)', lineHeight: 1.6, margin: 0 }}>Generate autonomous machine purchase instances on the Arc Network ledger layer.</p>
            </div>

            {error && (
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 14, padding: 16, marginBottom: 20, textAlign: 'center' }}>
                <p style={{ color: '#f87171', fontSize: 'clamp(12px, 1.2vw, 14px)', margin: 0 }}>{error}</p>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
              {[
                { label: 'Mock Item', value: 'Dispatch Node License' },
                { label: 'Gas Asset Strategy', value: 'USDC-Native Rails' },
                { label: 'Settlement Network', value: 'Arc Testnet • CCTP V2' },
              ].map((item, i) => (
                <div key={i} style={{ background: '#251c12', border: '1px solid #3d2e1a', borderRadius: 14, padding: 'clamp(12px, 1.5vw, 16px) clamp(14px, 2vw, 18px)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span style={{ color: '#6b5a45', fontSize: 'clamp(12px, 1.2vw, 14px)' }}>{item.label}</span>
                  <span style={{ color: i === 0 ? '#f0ece6' : '#c8975a', fontSize: 'clamp(12px, 1.2vw, 14px)', fontWeight: 600, fontFamily: i > 0 ? 'monospace' : 'inherit' }}>{item.value}</span>
                </div>
              ))}
            </div>

            <div style={{ background: 'rgba(200,151,90,0.06)', border: '1px solid rgba(200,151,90,0.2)', borderRadius: 14, padding: 'clamp(14px, 1.5vw, 18px)', marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ color: '#8a7560', fontSize: 'clamp(12px, 1.2vw, 14px)' }}>Amount Due</span>
              <span style={{ color: '#f0ece6', fontSize: 'clamp(18px, 4vw, 24px)', fontWeight: 800, fontFamily: 'monospace' }}>
                0.10 <span style={{ color: '#c8975a', fontSize: 'clamp(12px, 1.2vw, 14px)' }}>USDC</span>
              </span>
            </div>

            <button
              onClick={handleLaunchTestnetSession}
              disabled={isInitializing}
              style={{
                width: '100%',
                padding: 'clamp(14px, 2vw, 18px)',
                background: isInitializing ? 'rgba(200,151,90,0.3)' : '#c8975a',
                color: isInitializing ? 'rgba(14,11,8,0.5)' : '#0e0b08',
                border: 'none',
                borderRadius: 14,
                fontSize: 'clamp(14px, 1.5vw, 16px)',
                fontWeight: 800,
                cursor: isInitializing ? 'not-allowed' : 'pointer',
                letterSpacing: 0.5,
                transition: 'all 0.15s',
              }}
            >
              {isInitializing ? 'Minting Ledger Token...' : 'Launch Live Testnet Checkout'}
            </button>
          </div>

          <p style={{ textAlign: 'center', marginTop: 20, fontSize: 'clamp(9px, 0.8vw, 11px)', color: '#3d2e1a', fontFamily: 'monospace', letterSpacing: 1 }}>FLAREHQ PAYMENT INFRASTRUCTURE NODE • CIRCLE CCTP V2</p>
        </div>
      </div>
    </main>
  );
}

export default function CheckoutHubPage() {
  return (
    <Suspense
      fallback={
        <div style={{ minHeight: '100vh', background: '#0e0b08', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c8975a', padding: '24px' }}>Loading...</div>
      }
    >
      <CheckoutHubPageContent />
    </Suspense>
  );
}