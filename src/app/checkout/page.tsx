//src\app\checkout\page.tsx
'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { PaymentLog } from '@prisma/client';

function CheckoutHubPageContent() {
  const searchParams = useSearchParams();
  const paymentId = searchParams.get('id'); // Changed to 'id'
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
          email: '0x7a8214dad7630a7a39054e0121acdbc7a65821c9',
          merchant: 'Dispatch Marketplace',
        }),
      });
      const result = await res.json();
      if (result.success && result.checkoutUrl) {
        router.push(result.checkoutUrl); // Use the new checkoutUrl from the API
      } else {
        setError(result.error || 'Ledger rejected context token generation.');
      }
    } catch {
      setError('Unable to initialize connection with ArcFlare Gateway.');
    } finally {
      setIsInitializing(false);
    }
  };

  // New useEffect for fetching and polling payment details
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const fetchPaymentDetails = async () => {
      if (!paymentId) return;

      setIsLoadingPayment(true);
      try {
        const res = await fetch(`/api/payments?id=${paymentId}`); // Use 'id' query parameter
        const result = await res.json();

        if (result.success && result.payment) {
          setPayment(result.payment);
          // Stop polling if payment is settled or expired
          if (result.payment.status === 'SETTLED' || result.payment.status === 'EXPIRED') {
            clearInterval(intervalId);
          }
        } else {
          setError(result.error || 'Failed to fetch payment details.');
        }
      } catch (err) {
        setError('Error fetching payment details.');
        console.error('Error fetching payment details:', err);
      } finally {
        setIsLoadingPayment(false);
      }
    };

    if (paymentId) {
      fetchPaymentDetails(); // Initial fetch
      intervalId = setInterval(fetchPaymentDetails, 5000); // Poll every 5 seconds
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [paymentId]);

  if (paymentId && isLoadingPayment && !payment) {
    return (
      <main
        style={{
          minHeight: '100vh',
          background: '#0e0b08',
          color: '#f0ece6',
          fontFamily: 'Inter, system-ui, sans-serif',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ color: '#c8975a' }}>Loading payment details...</p>
      </main>
    );
  } else if (paymentId && payment) {
    // Display payment details (adapted from user's proposed AgentCheckoutHub)
    return (
      <main
        style={{
          minHeight: '100vh',
          background: '#050403',
          color: '#f0ece6',
          fontFamily: 'monospace',
          padding: 40,
        }}
      >
        <div
          style={{
            maxWidth: 600,
            margin: '0 auto',
            border: '1px dashed #2d2015',
            padding: 24,
            background: '#0e0b08',
          }}
        >
          <h2 style={{ color: '#c8975a', margin: '0 0 8px 0' }}>ARCFLARE HEADLESS HUB</h2>
          <p style={{ color: '#6b5a45', fontSize: 12, margin: '0 0 24px 0' }}>
            TARGET STATUS: {payment.status}
          </p>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: '#050403',
              padding: 16,
              borderRadius: 8,
            }}
          >
            <p style={{ margin: 0 }}>
              <strong>Recipient:</strong> {payment.merchant}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Invoice Ref:</strong> {payment.reference}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Settle Requirements:</strong>{' '}
              <span style={{ color: '#00ffcc' }}>
                {payment.amount} {payment.currency}
              </span>
            </p>
            {payment.agentSCA && (
              <p style={{ margin: 0 }}>
                <strong>Agent SCA:</strong> {payment.agentSCA}
              </p>
            )}
            {payment.arcTxHash && (
              <p style={{ margin: 0 }}>
                <strong>Transaction Hash:</strong> {payment.arcTxHash}
              </p>
            )}
          </div>

          <p style={{ color: '#3d2e1a', fontSize: 11, marginTop: 24, textAlign: 'center' }}>
            MACHINE OPTIMIZED CONTENT NODE — NO HMI REQUIRED
          </p>
        </div>
      </main>
    );
  }

  // Original UI for launching a testnet session if no paymentId
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0e0b08',
        color: '#f0ece6',
        fontFamily: 'Inter, system-ui, sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <header
        style={{
          borderBottom: '1px solid #2d2015',
          padding: '16px 48px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={40}
            height={40}
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
            <p
              style={{
                color: '#6b5a45',
                fontSize: 9,
                margin: 0,
                letterSpacing: 2,
                textTransform: 'uppercase',
                fontFamily: 'monospace',
              }}
            >
              Sandbox Environment
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
      </header>

      {/* Main */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 24px',
        }}
      >
        <div style={{ width: '100%', maxWidth: 480 }}>
          {/* Card */}
          <div
            style={{
              background: '#1a1410',
              border: '1px solid #2d2015',
              borderRadius: 28,
              padding: 40,
              boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
            }}
          >
            {/* Logo + badge */}
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                <Image
                  src="/arcflare-logo.png.png"
                  alt="ArcFlare"
                  width={56}
                  height={56}
                  style={{ borderRadius: 14, objectFit: 'contain' }}
                />
              </div>
              <div
                style={{
                  display: 'inline-block',
                  background: 'rgba(200,151,90,0.1)',
                  border: '1px solid rgba(200,151,90,0.3)',
                  borderRadius: 20,
                  padding: '4px 14px',
                  marginBottom: 16,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: '#c8975a',
                    fontFamily: 'monospace',
                    letterSpacing: 2,
                    textTransform: 'uppercase',
                  }}
                >
                  Arc Testnet v1.0
                </span>
              </div>
              <h2 style={{ fontSize: 28, fontWeight: 800, color: '#f0ece6', margin: '0 0 8px' }}>
                Developer Playbox
              </h2>
              <p style={{ color: '#6b5a45', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                Generate autonomous machine purchase instances on the Arc Network ledger layer.
              </p>
            </div>

            {/* Error */}
            {error && (
              <div
                style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 14,
                  padding: 16,
                  marginBottom: 20,
                  textAlign: 'center',
                }}
              >
                <p style={{ color: '#f87171', fontSize: 13, margin: 0 }}>{error}</p>
              </div>
            )}

            {/* Items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
              {[
                { label: 'Mock Item', value: 'Dispatch Node License' },
                { label: 'Gas Asset Strategy', value: 'USDC-Native Rails' },
                { label: 'Settlement Network', value: 'Arc Testnet • CCTP V2' },
              ].map((item, i) => (
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
                  <span style={{ color: '#6b5a45', fontSize: 13 }}>{item.label}</span>
                  <span
                    style={{
                      color: i === 0 ? '#f0ece6' : '#c8975a',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: i > 0 ? 'monospace' : 'inherit',
                    }}
                  >
                    {item.value}
                  </span>
                </div>
              ))}
            </div>

            {/* Amount */}
            <div
              style={{
                background: 'rgba(200,151,90,0.06)',
                border: '1px solid rgba(200,151,90,0.2)',
                borderRadius: 14,
                padding: '16px 18px',
                marginBottom: 24,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ color: '#8a7560', fontSize: 13 }}>Amount Due</span>
              <span
                style={{ color: '#f0ece6', fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}
              >
                0.10 <span style={{ color: '#c8975a', fontSize: 14 }}>USDC</span>
              </span>
            </div>

            {/* Button */}
            <button
              onClick={handleLaunchTestnetSession}
              disabled={isInitializing}
              style={{
                width: '100%',
                padding: '16px',
                background: isInitializing ? 'rgba(200,151,90,0.3)' : '#c8975a',
                color: isInitializing ? 'rgba(14,11,8,0.5)' : '#0e0b08',
                border: 'none',
                borderRadius: 14,
                fontSize: 15,
                fontWeight: 800,
                cursor: isInitializing ? 'not-allowed' : 'pointer',
                letterSpacing: 0.5,
                transition: 'all 0.15s',
              }}
            >
              {isInitializing ? 'Minting Ledger Token...' : 'Launch Live Testnet Checkout'}
            </button>
          </div>

          {/* Footer note */}
          <p
            style={{
              textAlign: 'center',
              marginTop: 20,
              fontSize: 11,
              color: '#3d2e1a',
              fontFamily: 'monospace',
              letterSpacing: 1,
            }}
          >
            ARCFLARE PAYMENT INFRASTRUCTURE NODE • CIRCLE CCTP V2
          </p>
        </div>
      </div>
    </main>
  );
}

export default function CheckoutHubPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            background: '#0e0b08',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#c8975a',
          }}
        >
          Loading...
        </div>
      }
    >
      <CheckoutHubPageContent />
    </Suspense>
  );
}
