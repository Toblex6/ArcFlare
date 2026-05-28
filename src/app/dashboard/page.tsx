"use client";

import React, { useEffect, useState } from "react";
import Image from "next/image";

interface PaymentItem {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  chain: string;
  status: string;
  sender_email: string;
  merchant: string;
  paid_at: string;
  cctp_telemetry: {
    source_domain: number;
    target_domain: number;
    attestation_status: string;
    nonce: number;
  };
}

interface DashboardMetrics {
  totalVolume: number;
  successRate: number;
  totalTransactions: number;
}

export default function MerchantDashboard() {
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>({ totalVolume: 0, successRate: 100, totalTransactions: 0 });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // --- Agent Deployment Interface States ---
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployedAgent, setDeployedAgent] = useState<any>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);

  const fetchLiveDatabaseState = async (isSilentUpdate = false) => {
    try {
      const res = await fetch("/api/payments/all");
      const json = await res.json();

      if (json.status) {
        setPayments(json.data);
        setMetrics(json.metrics);
        setError(null);
      } else {
        throw new Error(json.error || "Mismatched routing payload configuration.");
      }
    } catch (err: any) {
      console.error("Telemetry Retrieval Error:", err);
      if (!isSilentUpdate) setError("Failed to synchronize dashboard metrics with cloud engine.");
    } finally {
      setLoading(false);
    }
  };

  // --- Interactive Trigger for API Route Handler ---
  const triggerAgentLifecycle = async () => {
    setIsDeploying(true);
    setDeploymentError(null);
    try {
      const res = await fetch("/api/agent/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName: "DeFi Arbitrage Agent v1.0",
          metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei"
        })
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || "On-chain lifecycle execution failed.");
      }

      setDeployedAgent(data);
    } catch (err: any) {
      console.error("Deployment Routine Error:", err);
      setDeploymentError(err.message || "Failed to finalize agent configuration framework.");
    } finally {
      setIsDeploying(false);
    }
  };

  useEffect(() => {
    fetchLiveDatabaseState();

    const interval = setInterval(() => {
      fetchLiveDatabaseState(true);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#120b08] text-white flex items-center justify-center">
        <p className="text-amber-400 animate-pulse tracking-widest text-sm font-mono uppercase">SYNCING TESTNET TELEMETRY INSTANCE...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10 font-sans">
      <div className="max-w-6xl mx-auto mb-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-center">
        <p className="text-xs text-amber-400 font-mono tracking-wide uppercase">
          ⚠️ ArcFlare Ecosystem Monitoring Node — Running on <span className="underline font-bold">Arc Testnet Mode</span>. Connected to Live Cloud Ledger.
        </p>
      </div>

      <div className="max-w-6xl mx-auto">
        {/* Header Segment */}
        <div className="flex items-center justify-between border-b border-[#3a2a20] pb-6 mb-10">
          <div className="flex items-center gap-4">
            <Image src="/arcflare-logo.png" alt="ArcFlare Logo" width={50} height={50} className="object-contain" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">ArcFlare Merchant Terminal</h1>
              <p className="text-xs text-gray-400">Agentic Commerce & Stablecoin Ledger Telemetry</p>
            </div>
          </div>
          <span className="text-xs bg-amber-400/10 text-amber-300 px-3 py-1.5 border border-amber-400/20 rounded-full font-mono uppercase tracking-wider animate-pulse">
            ● Live Network Node Active
          </span>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400 font-mono">
            Error: {error}
          </div>
        )}

        {/* Core Metrics Grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Testnet Volume Settled</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">
              {metrics.totalVolume.toFixed(2)} <span className="text-sm font-medium text-amber-400">tUSDC</span>
            </h2>
          </div>

          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Total M2M Operations</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">
              {metrics.totalTransactions} <span className="text-xs font-normal text-gray-500">Recorded Tx</span>
            </h2>
          </div>

          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <div className="flex justify-between items-center mb-2">
              <p className="text-gray-400 text-xs uppercase tracking-wider">CCTP Attestation Precision</p>
              <span className="text-cyan-300 font-bold text-sm font-mono">{metrics.successRate.toFixed(1)}%</span>
            </div>
            <div className="w-full h-2.5 bg-[#120b08] rounded-full overflow-hidden mt-3">
              <div className="h-full bg-amber-400 transition-all duration-500" style={{ width: `${metrics.successRate}%` }}></div>
            </div>
          </div>
        </div>

        {/* NEW: ERC-8004 Agent Integration Pipeline Interface */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#3a2a20]/60 pb-4">
            <div>
              <h3 className="text-base font-bold tracking-wide">ERC-8004 Agent Provisioning Pipeline</h3>
              <p className="text-xs text-gray-400 mt-0.5">Programmatically instantiate sandboxed SCA nodes with multi-layer registry tracking</p>
            </div>
            <button
              onClick={triggerAgentLifecycle}
              disabled={isDeploying}
              className={`font-mono text-xs uppercase tracking-wider px-5 py-3 rounded-xl font-bold border transition-all ${
                isDeploying
                  ? "bg-amber-500/5 text-amber-400/40 border-amber-500/10 cursor-not-allowed animate-pulse"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20 active:scale-[0.98]"
              }`}
            >
              {isDeploying ? "COMPILING & POLLING BLOCKS..." : "⚡ LAUNCH AGENT LIFECYCLE"}
            </button>
          </div>

          {/* Deployment Error Alert */}
          {deploymentError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-xs font-mono text-red-400">
              ❌ Operational Exception: {deploymentError}
            </div>
          )}

          {/* Live Dynamic Agent Metadata Footprint Display */}
          {deployedAgent && (
            <div className="bg-[#120b08]/60 border border-[#3a2a20]/40 rounded-2xl p-4 space-y-4 font-mono text-xs">
              <div className="flex items-center justify-between border-b border-[#3a2a20]/30 pb-2">
                <span className="text-green-400 font-bold tracking-wide flex items-center gap-1.5 uppercase">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-ping" /> Live Agent Registry Footprint Bound
                </span>
                <span className="text-gray-400">Agent Token ID: <span className="text-amber-400 font-bold">#{deployedAgent.agentId}</span></span>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <span className="text-gray-500 text-[11px] uppercase tracking-wider">Owner SCA Node Address</span>
                  <div className="p-2.5 bg-[#1f140f] border border-[#3a2a20]/60 text-gray-300 rounded-lg select-all truncate">
                    {deployedAgent.wallets?.owner}
                  </div>
                </div>