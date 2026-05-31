"use client";

import React, { useEffect, useState } from "react";

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
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "arc_live_fa8d822ac7713302ea287a183a15cacdbfcb5d1a5477fae2",
        },
        body: JSON.stringify({
          agentName: "DeFi Arbitrage Agent v1.0",
          metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei",
        }),
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
        <p className="text-amber-400 animate-pulse tracking-widest text-sm font-mono uppercase">
          SYNCING TESTNET TELEMETRY INSTANCE...
        </p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10 font-sans">
      
      {/* Warning Banner */}
      <div className="max-w-6xl mx-auto mb-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-center">
        <p className="text-xs text-amber-400 font-mono tracking-wide uppercase">
          ⚠️ ArcFlare Ecosystem Monitoring Node — Running on{" "}
          <span className="underline font-bold">Arc Testnet Mode</span>.
          Connected to Live Cloud Ledger.
        </p>
      </div>

      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#3a2a20] pb-6 mb-10">
          <h1 className="text-2xl font-bold tracking-tight">ArcFlare Merchant Terminal</h1>
          <span className="text-xs bg-amber-400/10 text-amber-300 px-3 py-1.5 border border-amber-400/20 rounded-full font-mono uppercase tracking-wider animate-pulse">
            ● Live Network Node Active
          </span>
        </div>

        {/* Metrics Grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Testnet Volume Settled</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">
              {metrics.totalVolume.toFixed(2)}{" "}
              <span className="text-sm text-amber-400">tUSDC</span>
            </h2>
          </div>
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Total M2M Operations</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">{metrics.totalTransactions}</h2>
          </div>
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">CCTP Attestation Precision</p>
            <h2 className="text-3xl font-extrabold text-cyan-300 font-mono">
              {metrics.successRate.toFixed(1)}%
            </h2>
          </div>
        </div>

        {/* Agent Provisioning Pipeline */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#3a2a20]/60 pb-4">
            <div>
              <h3 className="text-base font-bold tracking-wide">ERC-8004 Agent Provisioning Pipeline</h3>
              <p className="text-xs text-gray-400 mt-0.5">Programmatically instantiate sandboxed SCA nodes</p>
            </div>
            <button
              onClick={triggerAgentLifecycle}
              disabled={isDeploying}
              className={`font-mono text-xs uppercase px-5 py-3 rounded-xl font-bold border transition-all ${
                isDeploying
                  ? "bg-amber-500/5 text-amber-400/40 border-amber-500/10 cursor-not-allowed"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20"
              }`}
            >
              {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT LIFECYCLE"}
            </button>
          </div>
          {deploymentError && (
            <div className="text-red-400 text-xs font-mono">❌ {deploymentError}</div>
          )}
          {deployedAgent && (
            <div className="bg-[#120b08]/60 border border-[#3a2a20]/40 rounded-2xl p-4 font-mono text-xs">
              <span className="text-green-400 font-bold uppercase">
                ● Live Agent Registry Bound: #{deployedAgent.agentId}
              </span>
            </div>
          )}
        </div>

        {/* Settlement Streams Table */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-base font-bold tracking-wide uppercase font-mono">
              Inbound Agent Settlement Streams
            </h3>
            <span className="text-xs text-gray-500 font-mono bg-[#120b08] px-3 py-1 rounded-lg border border-[#3a2a20]">
              Prisma Database Synchronization
            </span>
          </div>

          {error && (
            <div className="text-red-400 text-xs font-mono mb-4">❌ {error}</div>
          )}

          {payments.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-sm font-mono">No settlement streams recorded yet.</p>
              <p className="text-gray-600 text-xs mt-2">Payments will appear here after checkout.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-gray-500 uppercase tracking-wider border-b border-[#3a2a20]">
                    <th className="text-left pb-3 pr-4">Reference / Timestamp</th>
                    <th className="text-left pb-3 pr-4">Entity M2M Graph</th>
                    <th className="text-left pb-3 pr-4">Execution Domain</th>
                    <th className="text-left pb-3 pr-4">Payload Value</th>
                    <th className="text-left pb-3 pr-4">Status</th>
                    <th className="text-left pb-3">Circle CCTP Attestation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#3a2a20]/40">
                  {payments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-[#120b08]/40 transition-colors">
                      
                      {/* Reference + Timestamp */}
                      <td className="py-4 pr-4">
                        <div className="text-cyan-300">{payment.reference.slice(0, 16)}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">
                          {new Date(payment.paid_at).toLocaleString()}
                        </div>
                      </td>

                      {/* Entity M2M Graph */}
                      <td className="py-4 pr-4">
                        <div className="text-gray-300">{payment.sender_email}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">
                          → Merchant: {payment.merchant}
                        </div>
                      </td>

                      {/* Execution Domain */}
                      <td className="py-4 pr-4">
                        <span className="bg-cyan-400/10 text-cyan-300 px-2 py-0.5 rounded border border-cyan-400/20 text-[10px]">
                          {payment.chain.length > 20 ? "Arc-L1" : payment.chain}
                        </span>
                      </td>

                      {/* Payload Value */}
                      <td className="py-4 pr-4">
                        <div className="text-white font-bold">{payment.amount.toFixed(2)}</div>
                        <div className="text-amber-400 text-[10px]">{payment.currency}</div>
                      </td>

                      {/* Status */}
                      <td className="py-4 pr-4">
                        <span className={`px-2 py-1 rounded text-[10px] font-bold border ${
                          payment.status === "SUCCESS"
                            ? "bg-green-500/10 text-green-400 border-green-500/20"
                            : payment.status === "ATTESTATION_FAILED"
                            ? "bg-red-500/10 text-red-400 border-red-500/20"
                            : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                        }`}>
                          {payment.status === "SUCCESS" ? "SUCCESS" : 
                           payment.status === "ATTESTATION_FAILED" ? "FAILED" : "PENDING"}
                        </span>
                      </td>

                      {/* CCTP Attestation */}
                      <td className="py-4">
                        <div className={`text-[10px] ${
                          payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED"
                            ? "text-green-400"
                            : "text-amber-400"
                        }`}>
                          {payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED"
                            ? "REDEEMED_AND_MINTED"
                            : "POLLING_CIRCLE_TESTNET_IRIS_API"}
                        </div>
                        <div className="text-gray-600 text-[10px] mt-0.5">
                          Nonce: {payment.cctp_telemetry.nonce}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </main>
  );
}
