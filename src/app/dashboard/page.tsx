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
      if (!isSilentUpdate) setError("Failed to synchronize dashboard metrics with cloud engine.");
    } finally {
      setLoading(false);
    }
  };

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
      if (!res.ok || data.error) throw new Error(data.error || "On-chain lifecycle execution failed.");
      setDeployedAgent(data);
    } catch (err: any) {
      setDeploymentError(err.message || "Failed to finalize agent configuration framework.");
    } finally {
      setIsDeploying(false);
    }
  };

  useEffect(() => {
    fetchLiveDatabaseState();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchLiveDatabaseState(true);
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
    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10 font-sans selection:bg-amber-400 selection:text-black">
      <div className="max-w-6xl mx-auto mb-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-center">
        <p className="text-xs text-amber-400 font-mono tracking-wide uppercase">
          ⚠️ ArcFlare Ecosystem Monitoring Node — Running on <span className="underline font-bold">Arc Testnet Mode</span>.
        </p>
      </div>

      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between border-b border-[#3a2a20] pb-6 mb-10">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold tracking-tight">ArcFlare Merchant Terminal</h1>
          </div>
          <span className="text-xs bg-amber-400/10 text-amber-300 px-3 py-1.5 border border-amber-400/20 rounded-full font-mono uppercase tracking-wider animate-pulse">
            ● Live Network Node Active
          </span>
        </div>

        {/* Core Metrics Grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Testnet Volume Settled</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">{metrics.totalVolume.toFixed(2)} <span className="text-sm text-amber-400">tUSDC</span></h2>
          </div>
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Total M2M Operations</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">{metrics.totalTransactions}</h2>
          </div>
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">CCTP Attestation Precision</p>
            <h2 className="text-3xl font-extrabold text-cyan-300 font-mono">{metrics.successRate.toFixed(1)}%</h2>
          </div>
        </div>

        {/* ERC-8004 Agent Provisioning Pipeline */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#3a2a20]/60 pb-4">
            <div>
              <h3 className="text-base font-bold tracking-wide">ERC-8004 Agent Provisioning Pipeline</h3>
              <p className="text-xs text-gray-400 mt-0.5">Programmatically instantiate sandboxed SCA nodes</p>
            </div>
            <button
              onClick={triggerAgentLifecycle}
              disabled={isDeploying}
              className={`font-mono text-xs uppercase px-5 py-3 rounded-xl font-bold border ${isDeploying ? "bg-amber-500/5 text-amber-400/40 border-amber-500/10 cursor-not-allowed" : "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20"}`}
            >
              {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT LIFECYCLE"}
            </button>
          </div>
          {deploymentError && <div className="text-red-400 text-xs font-mono">❌ {deploymentError}</div>}
          {deployedAgent && (
            <div className="bg-[#120b08]/60 border border-[#3a2a20]/40 rounded-2xl p-4 font-mono text-xs">
              <span className="text-green-400 font-bold uppercase">● Live Agent Registry Bound: #{deployedAgent.agentId}</span>
            </div>
          )}
        </div>

        {/* Settlement Table remains the same... */}
      </div>
    </main>
  );
}