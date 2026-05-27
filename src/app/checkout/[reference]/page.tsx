"use client";

import React, { useEffect, useState, use } from "react";
import Image from "next/image";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSendTransaction, useChainId } from "wagmi";
import { parseEther } from "viem";

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

export default function CheckoutPage({ params }: { params: Promise<{ reference: string }> }) {
  // 1. Resolve parameters for Next.js async context
  const resolvedParams = use(params);
  const reference = resolvedParams.reference;

  // 2. Local Wallet Integration Hooks
  const { isConnected, address } = useAccount();
  const currentChainId = useChainId();
  const { sendTransaction, isPending: isTxPending } = useSendTransaction();

  // 3. Reactive State Management
  const [payment, setPayment] = useState<PaymentLogData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  // 4. Fetch the real tracking parameters from your backend ledger
  const fetchLedgerStatus = async (hash?: string) => {
    try {
      let url = `/api/payments/verify/${reference}`;
      if (hash) url += `?txHash=${hash}`;

      const res = await fetch(url);
      const result = await res.json();

      if (result.status && result.data) {
        setPayment(result.data);
      } else {
        setError(result.message || "Failed to resolve reference ledger entry.");
      }
    } catch (err) {
      setError("Operational server error occurred while syncing transactions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (reference) {
      fetchLedgerStatus();
    }
  }, [reference]);

  // 5. Payment Handler linking Web3 transactions directly into the backend ledger
  const handlePayment = async () => {
    try {
      console.log("🚀 Starting ArcFlare Payment Pipeline for Reference:", reference);

      // Execute on-chain burn/transfer strategy via Wagmi
      sendTransaction(
        {
          to: "0x000000000000000000000000000000000000dead",
          value: parseEther("0.001"), // Can map to payment.amount dynamically later
        },
        {
          onSuccess: async (txHash) => {
            console.log("⛓️ Transaction submitted successfully! Hash:", txHash);
            setIsVerifying(true);
            // Pass the resulting hash into your verify route to mark the ledger SUCCESS
            await fetchLedgerStatus(txHash);
            setIsVerifying(false);
          },
          onError: (txError) => {
            console.error("❌ On-chain user interaction rejected:", txError.message);
          }
        }
      );
    } catch (err) {
      console.error("Unexpected checkout layer failure:", err);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-[#120b08] text-white flex items-center justify-center">
        <p className="text-cyan-300 tracking-widest animate-pulse uppercase text-sm">
          Syncing ArcFlare Ledger Parameters...
        </p>
      </main>
    );
  }

  if (error || !payment) {
    return (
      <main className="min-h-screen bg-[#120b08] text-white flex items-center justify-center px-6">
        <div className="bg-[#1f140f] border border-red-500/30 rounded-3xl p-8 max-w-md text-center shadow-2xl">
          <p className="text-red-400 font-bold mb-2">Ledger Disconnect</p>
          <p className="text-gray-400 text-sm">{error || "The reference could not be found."}</p>
        </div>
      </main>
    );
  }

  const isConfirmed = payment.status === "SUCCESS";

  return (
    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10">
      
      {/* HEADER */}
      <div className="max-w-6xl mx-auto flex items-center justify-between mb-12">
        <div className="flex items-center gap-4">
          <Image
            src="/arcflare-logo.png"
            alt="ArcFlare Logo"
            width={55}
            height={55}
            priority
            className="object-contain"
          />
          <div>
            <h1 className="text-3xl font-bold tracking-wide">ArcFlare</h1>
            <p className="text-cyan-300 text-sm">Stablecoin Payment Infrastructure</p>
          </div>
        </div>
        <ConnectButton />
      </div>

      {/* MAIN SECTION */}
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-10">
        
        {/* LEFT PANEL - DYNAMIC CHECKOUT METRICS */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-8 shadow-2xl">
          <div className="mb-8">
            <p className="text-cyan-300 uppercase text-sm tracking-widest mb-2">Hosted Checkout</p>
            <h2 className="text-4xl font-bold leading-tight">Seamless Stablecoin Payments on Arc</h2>
          </div>

          <div className="space-y-5">
            {/* MERCHANT */}
            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Merchant</span>
                <span className="font-semibold">{payment.merchant || "ArcFlare Merchant"}</span>
              </div>
            </div>

            {/* REFERENCE TOKEN */}
            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Payment Reference</span>
                <span className="font-mono text-xs text-gray-300 bg-[#120b08] px-2.5 py-1 rounded-md tracking-wider">
                  {payment.reference}
                </span>
              </div>
            </div>

            {/* AMOUNT */}
            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Amount Due</span>
                <span className="font-semibold text-2xl tracking-tight text-white">
                  {payment.amount} <span className="text-lg font-medium text-cyan-300">{payment.currency}</span>
                </span>
              </div>
            </div>

            {/* SETTLEMENT NETWORK */}
            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Target Settlement Layer</span>
                <span className="font-semibold text-cyan-300">{payment.chain}</span>
              </div>
            </div>

            {/* SOURCE CHAIN ID */}
            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Connected Chain ID</span>
                <span className="font-semibold text-cyan-300">{currentChainId}</span>
              </div>
            </div>

            {/* WALLET */}
            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">
              <div className="flex flex-col gap-3">
                <span className="text-gray-400">Connected Wallet Address</span>
                <span className="font-semibold break-all text-sm font-mono text-gray-300">
                  {address ? address : "No wallet linked"}
                </span>
              </div>
            </div>
          </div>

          {/* PAYMENT TRANSACTION BUTTON */}
          <div className="mt-10">
            {isConnected ? (
              <button
                onClick={handlePayment}
                disabled={isTxPending || isVerifying || isConfirmed}
                className={`w-full transition-all font-bold py-4 rounded-2xl text-lg ${
                  isConfirmed 
                    ? "bg-green-500/10 text-green-400 border border-green-500/20 cursor-default" 
                    : "bg-cyan-400 hover:bg-cyan-300 text-black shadow-lg shadow-cyan-400/10 active:scale-[0.99]"
                }`}
              >
                {isConfirmed 
                  ? "✓ Ledger Settlement Confirmed" 
                  : isTxPending || isVerifying 
                    ? "Processing Block..." 
                    : `Pay ${payment.amount} ${payment.currency}`
                }
              </button>
            ) : (
              <div className="bg-[#2a1c15] border border-[#493328] rounded-2xl p-6 text-center">
                <p className="text-gray-300 mb-4">Connect your wallet to authorize transaction execution</p>
                <div className="flex justify-center">
                  <ConnectButton />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANEL - REAL-TIME PAYMENT ANALYTICS */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-8 shadow-2xl flex flex-col justify-between">
          <div>
            <h3 className="text-2xl font-bold mb-8">Payment Gateway Tracking</h3>

            {/* METRICS BLOCKS */}
            <div className="grid grid-cols-2 gap-5 mb-8">
              <div className="bg-[#2a1c15] p-6 rounded-2xl border border-[#493328]">
                <p className="text-gray-400 text-sm mb-2">Network Status</p>
                <h2 className={`text-xl font-bold ${isConfirmed ? "text-green-400" : "text-yellow-400 animate-pulse"}`}>
                  {isConfirmed ? "SUCCESS" : "PENDING"}
                </h2>
              </div>
              <div className="bg-[#2a1c15] p-6 rounded-2xl border border-[#493328]">
                <p className="text-gray-400 text-sm mb-2">System Response</p>
                <h2 className="text-xl font-bold text-gray-200">{payment.gateway_response}</h2>
              </div>
            </div>

            {/* SUCCESS RATE METRIC */}
            <div className="bg-[#2a1c15] rounded-2xl p-6 border border-[#493328] mb-6">
              <div className="flex justify-between mb-4">
                <span className="text-gray-400">Gateway Infrastructure Success Rate</span>
                <span className="text-cyan-300 font-bold">98.2%</span>
              </div>
              <div className="w-full h-3 bg-[#120b08] rounded-full overflow-hidden">
                <div className="w-[98.2%] h-full bg-cyan-400 rounded-full"></div>
              </div>
            </div>

            {/* TRANSACTION RECORD LEDGER */}
            <div className="bg-[#2a1c15] rounded-2xl p-6 border border-[#493328]">
              <h4 className="text-lg font-semibold mb-5">Current Ledger Instance</h4>
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Reference Token</span>
                  <span className="font-mono text-cyan-300">{payment.reference.slice(0, 12)}...</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Payer Entity</span>
                  <span className="text-gray-300">{payment.sender_email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Settled Block Time</span>
                  <span className="text-gray-300 text-xs">
                    {payment.paid_at ? new Date(payment.paid_at).toLocaleString() : "Awaiting settlement"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* BRAND FOOTER STATEMENT */}
          <div className="mt-8 bg-[#120b08] rounded-2xl p-5 border border-cyan-400/20">
            <div className="flex justify-between items-center mb-3">
              <p className="text-gray-400 font-medium">ArcFlare Engine</p>
              <p className="text-cyan-300 text-sm tracking-wide bg-cyan-400/5 px-2.5 py-0.5 border border-cyan-400/20 rounded-full">
                Active Rails
              </p>
            </div>
            <p className="text-sm text-gray-400 leading-relaxed">
              ArcFlare is building programmable stablecoin settlement infrastructure on Arc with native support for 
              Circle CCTP cross-chain machine execution protocols.
            </p>
          </div>

        </div>
      </div>

    </main>
  );
}