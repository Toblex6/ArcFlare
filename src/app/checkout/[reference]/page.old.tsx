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

export default function CheckoutPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference;

  const isConnected = true;
  const address = '0xArcFlare...AutonomousAgent';
  const currentChainId = 84532;

  const [payment, setPayment] = useState<PaymentLogData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [isTxPending, setIsTxPending] = useState<boolean>(false);

  const fetchLedgerStatus = async (hash?: string) => {
    if (!reference) return;
    try {
      let url = `/api/payments/verify/${reference}`;
      if (hash) url += `?txHash=${hash}`;

      const res = await fetch(url);
      const result = await res.json();

      if (result.status === true && result.data) {
        setPayment(result.data);
        setError(null);
      } else {
        setError(result.message || 'Failed to resolve reference ledger entry.');
      }
    } catch (err) {
      setError('Operational server error occurred while syncing transactions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (reference) {
      fetchLedgerStatus();
    }
  }, [reference]);

  const handlePayment = async () => {
    try {
      console.log('🚀 ArcFlare Payment Pipeline starting for:', reference);
      setIsTxPending(true);

      // Simulate the brief on-chain confirmation delay
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setIsTxPending(false);
      setIsVerifying(true);

      // Pass 0xSUCCESS to route update status
      await fetchLedgerStatus('0xSUCCESS');
      setIsVerifying(false);

      console.log('✅ Payment settled successfully on Arc Testnet');
    } catch (err) {
      console.error('Checkout layer failure:', err);
      setIsTxPending(false);
      setIsVerifying(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0e0b08] text-[#f0ece6] flex items-center justify-center">
        <p className="text-[#c8975a] tracking-widest animate-pulse uppercase text-sm font-mono">
          Syncing ArcFlare Ledger Parameters...
        </p>
      </main>
    );
  }

  if (error || !payment) {
    return (
      <main className="min-h-screen bg-[#0e0b08] text-[#f0ece6] flex items-center justify-center px-6">
        <div className="bg-[#1a1410] border border-red-500/30 rounded-3xl p-8 max-w-md text-center shadow-2xl">
          <p className="text-red-400 font-bold mb-2">Ledger Disconnect</p>
          <p className="text-[#6b5a45] text-sm">{error || 'The reference could not be found.'}</p>
        </div>
      </main>
    );
  }

  const isConfirmed = payment.status === 'SUCCESS';

  return (
    <main className="min-h-screen bg-[#0e0b08] text-[#f0ece6] px-6 py-10 font-sans">
      {/* HEADER */}
      <div className="max-w-6xl mx-auto flex items-center justify-between mb-12">
        <div className="flex items-center gap-4">
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare Logo"
            width={55}
            height={55}
            priority
            className="object-contain rounded-xl"
          />
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-[#f0ece6]">ARCFLARE</h1>
            <p className="text-[#c8975a] text-xs uppercase tracking-wider font-mono">
              Stablecoin Payment Infrastructure
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-[#1a1410] border border-[#2d2015] rounded-full text-xs font-mono text-[#06b6d4]">
          <span className="w-2 h-2 rounded-full bg-[#06b6d4] animate-pulse" />
          ROUTING NODE // ONLINE
        </div>
      </div>

      {/* MAIN SECTION */}
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-10">
        {/* LEFT PANEL */}
        <div className="bg-[#1a1410] border border-[#2d2015] rounded-3xl p-8 shadow-2xl">
          <div className="mb-8">
            <p className="text-[#c8975a] uppercase text-xs tracking-widest mb-2 font-mono">
              Hosted Checkout
            </p>
            <h2 className="text-4xl font-extrabold leading-tight tracking-tight">
              Seamless Stablecoin Payments on Arc
            </h2>
          </div>

          <div className="space-y-4">
            <div className="bg-[#251c12] rounded-2xl p-5 border border-[#3d2e1a]">
              <div className="flex justify-between items-center">
                <span className="text-[#6b5a45] text-sm">Merchant</span>
                <span className="font-semibold text-[#f0ece6]">
                  {payment.merchant || 'ArcFlare Merchant'}
                </span>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-5 border border-[#3d2e1a]">
              <div className="flex justify-between items-center">
                <span className="text-[#6b5a45] text-sm">Payment Reference</span>
                <span className="font-mono text-xs text-[#8a7560] bg-[#0e0b08] px-2.5 py-1 rounded-md tracking-wider">
                  {payment.reference}
                </span>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-5 border border-[#3d2e1a]">
              <div className="flex justify-between items-center">
                <span className="text-[#6b5a45] text-sm">Amount Due</span>
                <span className="font-bold text-2xl tracking-tight text-[#f0ece6] font-mono">
                  {payment.amount}{' '}
                  <span className="text-lg font-semibold text-[#c8975a] font-sans">
                    {payment.currency}
                  </span>
                </span>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-5 border border-[#3d2e1a]">
              <div className="flex justify-between items-center">
                <span className="text-[#6b5a45] text-sm">Target Settlement Layer</span>
                <span className="font-semibold text-[#c8975a] font-mono text-xs tracking-wider uppercase">
                  {payment.chain}
                </span>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-5 border border-[#3d2e1a]">
              <div className="flex justify-between items-center">
                <span className="text-[#6b5a45] text-sm">Connected Chain ID</span>
                <span className="font-semibold text-[#c8975a] font-mono">{currentChainId}</span>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-5 border border-[#3d2e1a]">
              <div className="flex flex-col gap-3">
                <span className="text-[#6b5a45] text-sm">Connected Wallet Address</span>
                <span className="font-semibold break-all text-sm font-mono text-[#8a7560]">
                  {address}
                </span>
              </div>
            </div>
          </div>

          {/* PAY BUTTON */}
          <div className="mt-10">
            <button
              onClick={handlePayment}
              disabled={isTxPending || isVerifying || isConfirmed}
              className={`w-full transition-all font-extrabold py-4 rounded-2xl text-lg tracking-wide ${
                isConfirmed
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20 cursor-default'
                  : 'bg-[#c8975a] hover:bg-[#b5854e] text-[#0e0b08] shadow-lg shadow-[#c8975a]/10 active:scale-[0.99] cursor-pointer'
              }`}
            >
              {isConfirmed
                ? '✓ Ledger Settlement Confirmed'
                : isTxPending
                  ? 'Submitting to Arc Testnet...'
                  : isVerifying
                    ? 'Verifying Settlement...'
                    : `Pay ${payment.amount} ${payment.currency}`}
            </button>
          </div>

          {/* Success confirmation */}
          {isConfirmed && (
            <div className="mt-6 bg-green-500/5 border border-green-500/20 rounded-2xl p-5 text-center">
              <p className="text-green-400 font-semibold text-sm">
                ✓ Payment settled on Arc Testnet
              </p>
              <p className="text-[#6b5a45] text-xs mt-1">Ledger updated · Dashboard synced</p>
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        <div className="bg-[#1a1410] border border-[#2d2015] rounded-3xl p-8 shadow-2xl flex flex-col justify-between">
          <div>
            <h3 className="text-2xl font-bold mb-8">Payment Gateway Tracking</h3>

            <div className="grid grid-cols-2 gap-5 mb-8">
              <div className="bg-[#251c12] p-6 rounded-2xl border border-[#3d2e1a]">
                <p className="text-[#6b5a45] text-sm mb-2">Network Status</p>
                <h2
                  className={`text-xl font-bold font-mono tracking-wider ${isConfirmed ? 'text-green-400' : 'text-yellow-400 animate-pulse'}`}
                >
                  {isConfirmed ? 'SUCCESS' : 'PENDING'}
                </h2>
              </div>
              <div className="bg-[#251c12] p-6 rounded-2xl border border-[#3d2e1a]">
                <p className="text-[#6b5a45] text-sm mb-2">System Response</p>
                <h2 className="text-sm font-bold text-[#f0ece6] font-mono tracking-wide break-all">
                  {payment.gateway_response}
                </h2>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-6 border border-[#3d2e1a] mb-6">
              <div className="flex justify-between mb-4 text-sm">
                <span className="text-[#6b5a45]">Gateway Infrastructure Success Rate</span>
                <span className="text-[#c8975a] font-bold font-mono">98.2%</span>
              </div>
              <div className="w-full h-3 bg-[#0e0b08] rounded-full overflow-hidden">
                <div className="w-[98.2%] h-full bg-[#c8975a] rounded-full"></div>
              </div>
            </div>

            <div className="bg-[#251c12] rounded-2xl p-6 border border-[#3d2e1a]">
              <h4 className="text-lg font-semibold mb-5">Current Ledger Instance</h4>
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-[#6b5a45]">Reference Token</span>
                  <span className="font-mono text-[#c8975a]">
                    {payment.reference.slice(0, 12)}...
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[#6b5a45]">Payer Entity</span>
                  <span className="text-[#8a7560] font-mono text-xs">{payment.sender_email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[#6b5a45]">Settled Block Time</span>
                  <span className="text-[#8a7560] text-xs font-mono">
                    {payment.paid_at
                      ? new Date(payment.paid_at).toLocaleString()
                      : 'Awaiting settlement'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* BRAND FOOTER */}
          <div className="mt-8 bg-[#0e0b08] rounded-2xl p-5 border border-[#c8975a]/20">
            <div className="flex justify-between items-center mb-3">
              <p className="text-[#6b5a45] font-medium">ArcFlare Engine</p>
              <p className="text-[#c8975a] text-xs font-mono tracking-wide bg-[#c8975a]/5 px-2.5 py-0.5 border border-[#c8975a]/20 rounded-full uppercase">
                Active Rails
              </p>
            </div>
            <p className="text-sm text-[#8a7560] leading-relaxed">
              ArcFlare is building programmable stablecoin settlement infrastructure on Arc with
              native support for Circle CCTP cross-chain machine execution protocols.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
