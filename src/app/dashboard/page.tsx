"use client";

import React, { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";

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
  const [chartData, setChartData] = useState<any[]>([]);

  const fetchLiveDatabaseState = async (isSilentUpdate = false) => {
    try {
      const res = await fetch("/api/payments/all");
      const json = await res.json();
      if (json.status) {
        setPayments(json.data);
        setMetrics(json.metrics);
        setError(null);

        // Build chart data from real transactions grouped by day
        const grouped: Record<string, { volume: number; count: number }> = {};
        json.data.forEach((p: PaymentItem) => {
          const day = new Date(p.paid_at).toLocaleDateString("en-US", {
            month: "short", day: "numeric",
          });
          if (!grouped[day]) grouped[day] = { volume: 0, count: 0 };
          grouped[day].volume += p.amount;
          grouped[day].count += 1;
        });

        const days = Object.entries(grouped).slice(-7).map(([date, d]) => ({
          date,
          volume: parseFloat(d.volume.toFixed(2)),
          count: d.count,
        }));

        if (days.length === 0) {
          const today = new Date();
          setChartData(Array.from({ length: 7 }, (_, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() - (6 - i));
            return {
              date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
              volume: 0, count: 0,
            };
          }));
        } else {
          setChartData(days);
        }
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

  const successCount = payments.filter((p) => p.status === "SUCCESS").length;
  const failedCount = payments.filter((p) => p.status !== "SUCCESS").length;
  const avgTxValue = payments.length > 0 ? metrics.totalVolume / payments.length : 0;

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

        {/* Metrics Grid — 3 cards same as before, just with subtle trend line */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          {[
            {
              label: "Testnet Volume Settled",
              value: `${metrics.totalVolume.toFixed(2)}`,
              unit: "tUSDC",
              unitColor: "text-amber-400",
              color: "#f59e0b",
            },
            {
              label: "Total M2M Operations",
              value: `${metrics.totalTransactions}`,
              unit: "Recorded Tx",
              unitColor: "text-gray-400",
              color: "#0d7c5f",
            },
            {
              label: "CCTP Attestation Precision",
              value: `${metrics.successRate.toFixed(1)}%`,
              unit: successCount > 0 ? `${successCount} settled` : "No settlements yet",
              unitColor: "text-green-400",
              color: "#0d7c5f",
            },
          ].map((card, i) => (
            <div key={i} className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-3">{card.label}</p>
              <h2 className="text-3xl font-extrabold text-white font-mono mb-1">
                {card.value}{" "}
                <span className={`text-sm font-normal ${card.unitColor}`}>{card.unit}</span>
              </h2>
              {/* Mini sparkline from real data */}
              {chartData.length > 0 && (
                <div style={{ height: 40, marginTop: 12 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id={`spark${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={card.color} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={card.color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Area
                        type="monotone"
                        dataKey={i === 1 ? "count" : "volume"}
                        stroke={card.color}
                        strokeWidth={1.5}
                        fill={`url(#spark${i})`}
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── ANALYTICS CHART + GATEWAY OVERVIEW ─────────────────────────── */}
        <div className="grid lg:grid-cols-3 gap-6 mb-8">

          {/* Chart — takes 2 cols */}
          <div className="lg:col-span-2 bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-base font-bold tracking-wide">Payment Analytics</h3>
                <p className="text-xs text-gray-400 mt-0.5">Stablecoin transaction activity — last 7 days</p>
              </div>
              <span className="text-xs text-gray-500 font-mono bg-[#120b08] px-3 py-1 rounded-lg border border-[#3a2a20]">
                Live Data
              </span>
            </div>

            <div style={{ height: 180, marginTop: 16 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0d7c5f" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#0d7c5f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a1f10" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#6b5a45", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "#6b5a45", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#120b08",
                      border: "1px solid #3a2a20",
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                    labelStyle={{ color: "#9ca3af" }}
                    itemStyle={{ color: "#0d7c5f" }}
                    formatter={(val: any) => [`${val} USDC`, "Volume"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="volume"
                    stroke="#0d7c5f"
                    strokeWidth={2}
                    fill="url(#mainGrad)"
                    dot={{ fill: "#0d7c5f", r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: "#0d7c5f" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Sub metrics row */}
            <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-[#3a2a20]/60">
              {[
                { label: "Successful", value: successCount, color: "text-green-400", icon: "✓" },
                { label: "Failed", value: failedCount, color: "text-red-400", icon: "✗" },
                { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, color: "text-emerald-400", icon: "◎" },
                { label: "Avg Value", value: `$${avgTxValue.toFixed(2)}`, color: "text-amber-400", icon: "↗" },
              ].map((m, i) => (
                <div key={i} className="bg-[#120b08] border border-[#3a2a20]/60 rounded-xl p-3">
                  <div className="flex items-center gap-1 mb-1">
                    <span className={`text-xs ${m.color}`}>{m.icon}</span>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide">{m.label}</p>
                  </div>
                  <p className={`text-lg font-bold font-mono ${m.color}`}>{m.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Gateway Overview — 1 col */}
          <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold tracking-wide">Gateway Overview</h3>
              <div className="flex items-center gap-1.5 bg-green-500/10 border border-green-500/20 rounded-full px-2.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-[10px] text-green-400 font-mono">LIVE</span>
              </div>
            </div>

            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Total Revenue (USDC)</p>
            <p className="text-3xl font-bold font-mono text-white mb-1">
              {metrics.totalVolume.toFixed(2)}{" "}
              <span className="text-sm text-emerald-400">USDC</span>
            </p>
            <p className="text-xs text-gray-500 mb-6">≈ ${metrics.totalVolume.toFixed(2)}</p>

            {/* Success bar */}
            <div className="mb-4">
              <div className="flex justify-between mb-1">
                <p className="text-xs text-gray-400">Successful Payments</p>
                <p className="text-xs text-white font-mono">{metrics.successRate.toFixed(1)}%</p>
              </div>
              <p className="text-xl font-bold font-mono text-white mb-2">{successCount}</p>
              <div className="h-1.5 bg-[#120b08] rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-400 rounded-full transition-all duration-1000"
                  style={{ width: `${metrics.successRate}%` }}
                />
              </div>
            </div>

            {/* Failed bar */}
            <div className="mb-6">
              <div className="flex justify-between mb-1">
                <p className="text-xs text-gray-400">Failed Payments</p>
                <p className="text-xs text-white font-mono">{(100 - metrics.successRate).toFixed(1)}%</p>
              </div>
              <p className="text-xl font-bold font-mono text-white mb-2">{failedCount}</p>
              <div className="h-1.5 bg-[#120b08] rounded-full overflow-hidden">
                <div
                  className="h-full bg-red-400 rounded-full transition-all duration-1000"
                  style={{ width: `${100 - metrics.successRate}%` }}
                />
              </div>
            </div>

            {/* Agent Pipeline button */}
            <div className="mt-auto">
              <div className="border border-[#3a2a20]/60 rounded-2xl p-4 mb-4">
                <h4 className="text-xs font-bold uppercase tracking-wide mb-1">ERC-8004 Agent Provisioning Pipeline</h4>
                <p className="text-[10px] text-gray-500 mb-3">Programmatically instantiate sandboxed SCA nodes</p>
                <button
                  onClick={triggerAgentLifecycle}
                  disabled={isDeploying}
                  className={`w-full font-mono text-xs uppercase py-2.5 rounded-xl font-bold border transition-all ${
                    isDeploying
                      ? "bg-amber-500/5 text-amber-400/40 border-amber-500/10 cursor-not-allowed"
                      : "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20"
                  }`}
                >
                  {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT LIFECYCLE"}
                </button>
                {deploymentError && <p className="text-red-400 text-[10px] font-mono mt-2">❌ {deploymentError}</p>}
                {deployedAgent && <p className="text-green-400 text-[10px] font-mono mt-2">● Live Agent Registry Bound: #{deployedAgent.agentId}</p>}
              </div>
            </div>
          </div>
        </div>

        {/* Settlement Streams Table — exactly the same as before */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-base font-bold tracking-wide uppercase font-mono">
              Inbound Agent Settlement Streams
            </h3>
            <span className="text-xs text-gray-500 font-mono bg-[#120b08] px-3 py-1 rounded-lg border border-[#3a2a20]">
              Prisma Database Synchronization
            </span>
          </div>

          {error && <div className="text-red-400 text-xs font-mono mb-4">❌ {error}</div>}

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
                      <td className="py-4 pr-4">
                        <div className="text-emerald-400">{payment.reference.slice(0, 16)}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">
                          {new Date(payment.paid_at).toLocaleString()}
                        </div>
                      </td>
                      <td className="py-4 pr-4">
                        <div className="text-gray-300">{payment.sender_email}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">
                          → Merchant: {payment.merchant}
                        </div>
                      </td>
                      <td className="py-4 pr-4">
                        <span className="bg-emerald-400/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-400/20 text-[10px]">
                          {payment.chain.length > 20 ? "Arc-L1" : payment.chain}
                        </span>
                      </td>
                      <td className="py-4 pr-4">
                        <div className="text-white font-bold">{payment.amount.toFixed(2)}</div>
                        <div className="text-amber-400 text-[10px]">{payment.currency}</div>
                      </td>
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
                      <td className="py-4">
                        <div className={`text-[10px] ${
                          payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED"
                            ? "text-green-400" : "text-amber-400"
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
