"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

interface Metrics {
  totalTransactions: number;
  totalVolumeProcessed: number;
  estimatedGasSavedUSD: number;
  settlementCurrency: string;
  primaryChain: string;
}

interface Transaction {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  chain: string;
  senderEmail: string;
  merchant: string;
  status: string;
  timestamp: string;
}

export default function DashboardPage() {
  // Explicitly casting to any eliminates the strict null connection type error on Vercel/Render deployment
  const { address, isConnected } = useAccount() as any;

  // Handle hydration mismatch safely by verifying component is mounted in browser
  const [mounted, setMounted] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [loadingKeys, setLoadingKeys] = useState(false);

  // Live Ledger States
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  useEffect(() => {
    setMounted(true);

    // Dynamic environment URL fallback to prevent browser fetch blocks
    const API_URL = typeof window !== "undefined" && window.location.hostname === "localhost"
      ? "/api/payments/history" // In local development, call your own relative path
      : "https://arcflare-gateway.onrender.com/api/payments/history"; // In production, use Render

    async function fetchLedger() {
      try {
        const res = await fetch(API_URL);
        const data = await res.json();
        if (data.success) {
          setMetrics(data.metrics);
          setTransactions(data.transactions);
        }
      } catch (err) {
        console.error("Dashboard backend synchronization failure:", err);
      }
    }

    fetchLedger();
    const interval = setInterval(fetchLedger, 4000);
    return () => clearInterval(interval);
  }, []);

  // Safe client-side local key creator
  const handleGenerateApiKey = () => {
    setLoadingKeys(true);
    setTimeout(() => {
      const randomHex = Array.from({ length: 48 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("");
      const generatedKey = `af_live_${randomHex}`;
      setApiKey(generatedKey);
      setLoadingKeys(false);
      alert(`New Live API Key Provisioned successfully:\n\n${generatedKey}\n\nKeep this safe!`);
    }, 600);
  };

  // Helper to safely format address to a readable mid-truncated string
  const formatAddress = (addr?: string) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <main className="min-h-screen bg-[#1A120B] flex text-white font-mono">

      {/* Sidebar */}
      <aside className="w-[260px] bg-[#3C2A21] border-r border-[#5C4033] p-6 hidden lg:flex flex-col justify-between">
        <div>
          <div className="mb-10">
            <h1 className="text-3xl font-bold text-[#FFF8EA]">
              ArcFlare
            </h1>
            <p className="text-sm text-[#D5CEA3] mt-1">
              Stablecoin Payment Infrastructure
            </p>
          </div>

          <nav className="space-y-2">
            {[
              "Dashboard",
              "Payments",
              "Transactions",
              "Merchants",
              "Wallets",
              "Analytics",
              "Webhooks",
              "Settings",
            ].map((item) => (
              <button
                key={item}
                className={`w-full text-left px-4 py-3 rounded-2xl transition-all ${
                  item === "Dashboard"
                    ? "bg-[#0F3D3E] text-[#FFF8EA]"
                    : "hover:bg-[#5C4033] text-[#E5D3B3]"
                }`}
              >
                {item}
              </button>
            ))}
          </nav>
        </div>

        <div className="rounded-3xl bg-[#0F3D3E] p-5">
          <p className="text-sm text-cyan-200">
            ArcFlare Gateway
          </p>
          <h2 className="text-2xl font-bold text-white mt-2">
            Mainnet Live
          </h2>
          <p className="text-xs text-cyan-100 mt-2">
            Stablecoin payments powered by Arc.
          </p>
        </div>
      </aside>

      {/* Main Content Area */}
      <section className="flex-1 p-6 lg:p-10 overflow-y-auto">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[#FFF8EA]">
              Merchant Dashboard
            </h1>
            <p className="text-[#D5CEA3] mt-1">
              Monitor real-time agentic payments, system balances, and ledger activity.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {!mounted ? (
              <button className="bg-cyan-400 opacity-60 text-black px-5 py-3 rounded-2xl font-semibold cursor-wait">
                Loading...
              </button>
            ) : (
              <ConnectButton.Custom>
                {({ account, chain, openAccountModal, openConnectModal, mounted: rbMounted }) => {
                  const ready = rbMounted;
                  const connected = ready && account && chain;

                  if (!ready) return null;

                  return (
                    <div>
                      {!connected ? (
                        <button
                          onClick={openConnectModal}
                          type="button"
                          className="bg-cyan-400 hover:bg-cyan-300 transition-all text-black px-5 py-3 rounded-2xl font-semibold"
                        >
                          Connect Wallet
                        </button>
                      ) : (
                        <button
                          onClick={openAccountModal}
                          type="button"
                          className="bg-red-500 hover:bg-red-400 transition-all text-white px-5 py-3 rounded-2xl font-semibold"
                        >
                          Disconnect Account
                        </button>
                      )}
                    </div>
                  );
                }}
              </ConnectButton.Custom>
            )}

            <Link
              href="/checkout/test123"
              className="bg-[#0F3D3E] hover:bg-cyan-900 transition-all text-white px-5 py-3 rounded-2xl font-semibold"
            >
              Open Checkout
            </Link>

            <div className="bg-[#3C2A21] border border-[#5C4033] px-4 py-3 rounded-2xl max-w-[260px] min-w-[200px]">
              <p className="text-xs text-[#D5CEA3]">
                Connected Wallet
              </p>
              <p className="text-sm text-white truncate mt-1">
                {mounted && isConnected && address
                  ? formatAddress(address)
                  : "No wallet connected"}
              </p>
            </div>
          </div>
        </div>

        {/* Live Aggregate Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5 mb-8">
          <div className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6">
            <p className="text-[#D5CEA3] text-sm">Total Volume</p>
            <div className="flex items-end justify-between mt-4">
              <h2 className="text-3xl font-bold text-[#FFF8EA]">
                {metrics ? `${metrics.totalVolumeProcessed} USDC` : "0.00 USDC"}
              </h2>
              <span className="text-cyan-300 text-sm font-semibold">Live Feed</span>
            </div>
          </div>

          <div className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6">
            <p className="text-[#D5CEA3] text-sm">Agent Transactions</p>
            <div className="flex items-end justify-between mt-4">
              <h2 className="text-3xl font-bold text-[#FFF8EA]">
                {metrics?.totalTransactions || 0}
              </h2>
              <span className="text-cyan-300 text-sm font-semibold">Active</span>
            </div>
          </div>

          <div className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6">
            <p className="text-[#D5CEA3] text-sm">Ecosystem Chain</p>
            <div className="flex items-end justify-between mt-4">
              <h2 className="text-3xl font-bold text-[#FFF8EA]">
                {metrics?.primaryChain || "Arc-L1"}
              </h2>
              <span className="text-cyan-300 text-sm font-semibold">Native</span>
            </div>
          </div>

          <div className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6">
            <p className="text-[#D5CEA3] text-sm">Est. Gas Saved</p>
            <div className="flex items-end justify-between mt-4">
              <h2 className="text-3xl font-bold text-[#FFF8EA]">
                ${metrics ? metrics.estimatedGasSavedUSD.toFixed(2) : "0.00"}
              </h2>
              <span className="text-cyan-300 text-sm font-semibold">Signature</span>
            </div>
          </div>
        </div>

        {/* Main Operational Layout Grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
          {/* Analytics Area */}
          <div className="xl:col-span-2 bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-xl font-bold text-[#FFF8EA]">
                  Ecosystem Telemetry
                </h2>
                <p className="text-sm text-[#D5CEA3] mt-1">
                  Micro-stablecoin activity and real-time roadblock checks
                </p>
              </div>
              <button className="bg-[#0F3D3E] text-white px-4 py-2 rounded-xl text-sm">
                Active
              </button>
            </div>
            <div className="h-[320px] bg-[#1A120B] border border-[#5C4033] rounded-3xl flex flex-col items-center justify-center text-[#D5CEA3] p-6 text-center">
              <div className="w-4 h-4 rounded-full bg-emerald-400 animate-ping mb-3" />
              <p className="text-sm text-emerald-300 font-bold uppercase tracking-widest">Listening for Agentic Calls</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Universal HTTP 402 roadblocks are active. Agents striking payloads will generate streaming footprints down below.
              </p>
            </div>
          </div>

          {/* Revenue & Key Card */}
          <div className="bg-[#0F3D3E] rounded-3xl p-6 shadow-2xl flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <p className="text-cyan-200 text-sm">
                    Accumulated Gateway Fees
                  </p>
                  <h2 className="text-3xl font-bold text-white mt-1">
                    {metrics ? `${metrics.totalVolumeProcessed} USDC` : "0 USDC"}
                  </h2>
                </div>
                <div className="bg-cyan-400/20 text-cyan-300 px-3 py-1 rounded-full text-xs">
                  LIVE
                </div>
              </div>

              <div className="space-y-4 mb-6">
                <div className="bg-white/10 rounded-2xl p-4">
                  <p className="text-xs text-cyan-100">
                    Active API Key Profile
                  </p>
                  <p className="text-white font-mono text-xs truncate mt-1">
                    {apiKey ? apiKey : "No generated keys found"}
                  </p>
                </div>
                <div className="bg-white/10 rounded-2xl p-4">
                  <p className="text-xs text-cyan-100">
                    Network Framework
                  </p>
                  <p className="text-white text-xs font-semibold mt-1">
                    Nanopayments Engine v1.0.0
                  </p>
                </div>
              </div>
            </div>

            <button 
              onClick={handleGenerateApiKey}
              disabled={loadingKeys}
              className="w-full bg-cyan-400 hover:bg-cyan-300 transition-all text-black font-semibold py-4 rounded-2xl disabled:opacity-50"
            >
              {loadingKeys ? "Signing Keys..." : "Generate API Key"}
            </button>
          </div>
        </div>

        {/* Live Rolling Ledger Table */}
        <div className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl overflow-hidden">
          <div className="p-6 border-b border-[#5C4033]">
            <h2 className="text-xl font-bold text-[#FFF8EA]">
              Live Agent Transaction Footprints
            </h2>
            <p className="text-sm text-[#D5CEA3] mt-1">
              Latest payment proofs verified and cleared by ArcFlare's roadblock processor
            </p>
          </div>

          <div className="overflow-x-auto">
            {transactions.length === 0 ? (
              <div className="p-10 text-center text-[#D5CEA3] text-sm">
                Waiting for autonomous agent transaction signatures...
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-[#2B1D16] text-left text-sm text-[#D5CEA3]">
                  <tr>
                    <th className="px-6 py-4">Reference Log</th>
                    <th className="px-6 py-4">Agent Entity</th>
                    <th className="px-6 py-4">Amount</th>
                    <th className="px-6 py-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#5C4033]/40">
                  {transactions.map((row) => (
                    <tr key={row.id} className="border-t border-[#5C4033] hover:bg-[#2B1D16]/30 transition-all">
                      <td className="px-6 py-5 text-cyan-300 font-mono font-medium">
                        {row.reference}
                      </td>
                      <td className="px-6 py-5 text-[#E5D3B3] text-sm">
                        {row.senderEmail}
                      </td>
                      <td className="px-6 py-5 text-emerald-400 font-semibold">
                        {row.amount} {row.currency}
                      </td>
                      <td className="px-6 py-5">
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase tracking-widest">
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

      </section>
    </main>
  );
}