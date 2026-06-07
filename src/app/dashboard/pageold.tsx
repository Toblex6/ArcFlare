"use client";

import React, { useEffect, useState } from "react";
import Image from "next/image";
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

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", active: true },
  { label: "Homepage", href: "/", active: false },
  { label: "Transactions", href: "/transactions", active: false },
  { label: "Checkout", href: "/checkout", active: false },
  { label: "Escrow", href: "/escrow", active: false },
  { label: "Support", href: "/support", active: false },
];

function Sidebar({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <aside style={{
      width: 220, minHeight: "100vh", background: "#1f140f",
      display: "flex", flexDirection: "column", padding: "24px 14px",
      flexShrink: 0, position: "sticky", top: 0, height: "100vh", overflowY: "auto",
    }}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
        <Image
          src="/arcflare-logo.png"
          alt="ArcFlare"
          width={36}
          height={36}
          style={{ borderRadius: 8, objectFit: "contain" }}
        />
        <div>
          <p style={{ color: "#fff", fontSize: 14, fontWeight: 700, lineHeight: 1, margin: 0 }}>ArcFlare</p>
          <p style={{ color: "#4b5563", fontSize: 10, margin: "3px 0 0 0" }}>Stablecoin Payment Infrastructure</p>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
        {NAV_ITEMS.map((item) => (
          <a
            key={item.label}
            href={item.href}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 12px", borderRadius: 9,
              textDecoration: "none", fontSize: 13, fontWeight: 500,
              background: item.active ? "rgba(13,124,95,0.18)" : "transparent",
              color: item.active ? "#0d7c5f" : "#6b7280",
              border: item.active ? "1px solid rgba(13,124,95,0.25)" : "1px solid transparent",
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      {/* Balance */}
      <div style={{ background: "rgba(13,124,95,0.1)", border: "1px solid rgba(13,124,95,0.2)", borderRadius: 12, padding: 14, marginTop: 16 }}>
        <p style={{ color: "#4b5563", fontSize: 9, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 6px 0" }}>Total Balance</p>
        <p style={{ color: "#fff", fontSize: 20, fontWeight: 700, fontFamily: "monospace", margin: "0 0 2px 0" }}>
          {metrics.totalVolume.toFixed(2)} <span style={{ color: "#0d7c5f", fontSize: 12 }}>USDC</span>
        </p>
        <p style={{ color: "#4b5563", fontSize: 10, margin: "0 0 10px 0" }}>≈ ${metrics.totalVolume.toFixed(2)}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(13,124,95,0.15)", borderRadius: 8, padding: "6px 10px" }}>
          <span style={{ color: "#0d7c5f", fontSize: 12 }}>◎</span>
          <span style={{ color: "#0d7c5f", fontSize: 11, fontWeight: 600 }}>USDC Wallet</span>
          <span style={{ color: "#0d7c5f", marginLeft: "auto", fontSize: 12 }}>→</span>
        </div>
      </div>

      {/* Testnet badge */}
      <div style={{ marginTop: 12, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 10, padding: "8px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
          <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Arc Testnet Mode</span>
        </div>
      </div>
    </aside>
  );
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
        const grouped: Record<string, { volume: number; count: number }> = {};
        json.data.forEach((p: PaymentItem) => {
          const day = new Date(p.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          if (!grouped[day]) grouped[day] = { volume: 0, count: 0 };
          grouped[day].volume += p.amount;
          grouped[day].count += 1;
        });
        const days = Object.entries(grouped).slice(-7).map(([date, d]) => ({
          date, volume: parseFloat(d.volume.toFixed(2)), count: d.count,
        }));
        if (days.length === 0) {
          const today = new Date();
          setChartData(Array.from({ length: 7 }, (_, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() - (6 - i));
            return { date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), volume: 0, count: 0 };
          }));
        } else {
          setChartData(days);
        }
      } else {
        throw new Error(json.error);
      }
    } catch (err: any) {
      if (!isSilentUpdate) setError("Failed to synchronize dashboard metrics.");
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
        headers: { "Content-Type": "application/json", "x-api-key": "arc_live_fa8d822ac7713302ea287a183a15cacdbfcb5d1a5477fae2" },
        body: JSON.stringify({ agentName: "DeFi Arbitrage Agent v1.0", metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Lifecycle failed.");
      setDeployedAgent(data);
    } catch (err: any) {
      setDeploymentError(err.message);
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
      <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#0d7c5f", fontFamily: "monospace", fontSize: 13, letterSpacing: 2, textTransform: "uppercase" }}>
          SYNCING TESTNET TELEMETRY INSTANCE...
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f8fafc", fontFamily: "Inter, system-ui, sans-serif" }}>
      <Sidebar metrics={metrics} />
      <main style={{ flex: 1, padding: "32px 32px", overflowX: "hidden", background: "#f8fafc" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0f172a", margin: "0 0 4px 0" }}>Welcome back, Merchant Admin 👋</h1>
            <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>Here's what's happening with your business today.</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "7px 14px", fontSize: 13, color: "#64748b" }}>
              📅 {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(13,124,95,0.08)", border: "1px solid rgba(13,124,95,0.2)", borderRadius: 10, padding: "7px 14px" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#0d7c5f", display: "inline-block", animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 11, color: "#0d7c5f", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace" }}>Live Node Active</span>
            </div>
          </div>
        </div>

        {/* Warning Banner */}
        <div style={{ marginBottom: 24, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "9px 18px", textAlign: "center" }}>
          <p style={{ fontSize: 11, color: "#b45309", fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", margin: 0 }}>
            ⚠ ArcFlare Ecosystem Monitoring Node — Running on <span style={{ textDecoration: "underline", fontWeight: 700 }}>Arc Testnet Mode</span>. Connected to Live Cloud Ledger.
          </p>
        </div>

        {/* Metric Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          {[
            { label: "Total Volume", value: metrics.totalVolume.toFixed(2), unit: "USDC", change: "+18%", iconBg: "#dcfce7", iconColor: "#16a34a", icon: "$", dataKey: "volume", stroke: "#0d7c5f" },
            { label: "Transactions", value: metrics.totalTransactions.toString(), unit: "", change: "+12%", iconBg: "#ede9fe", iconColor: "#7c3aed", icon: "↔", dataKey: "count", stroke: "#8b5cf6" },
            { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, unit: "", change: "+3%", iconBg: "#fef9c3", iconColor: "#ca8a04", icon: "✓", dataKey: "volume", stroke: "#f59e0b" },
            { label: "Avg Tx Value", value: `$${avgTxValue.toFixed(2)}`, unit: "USDC", change: "+11%", iconBg: "#dbeafe", iconColor: "#2563eb", icon: "↗", dataKey: "volume", stroke: "#3b82f6" },
          ].map((card, i) => (
            <div key={i} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ width: 36, height: 36, background: card.iconBg, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: card.iconColor }}>{card.icon}</div>
                <span style={{ fontSize: 11, color: "#16a34a", fontWeight: 600, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 20, padding: "2px 8px" }}>{card.change}</span>
              </div>
              <p style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 4px 0" }}>{card.label}</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", fontFamily: "monospace", margin: "0 0 2px 0" }}>
                {card.value} <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 400 }}>{card.unit}</span>
              </p>
              <p style={{ fontSize: 10, color: "#94a3b8", margin: "0 0 10px 0" }}>vs last week</p>
              {chartData.length > 0 && (
                <div style={{ height: 36 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id={`cg${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={card.stroke} stopOpacity={0.2} />
                          <stop offset="95%" stopColor={card.stroke} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey={card.dataKey} stroke={card.stroke} strokeWidth={1.5} fill={`url(#cg${i})`} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Chart + Gateway */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, marginBottom: 24 }}>
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#0f172a", margin: 0 }}>Payment Analytics</h3>
                <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 3, marginBottom: 0 }}>Stablecoin transaction activity</p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "5px 12px", fontSize: 12, color: "#64748b", cursor: "pointer" }}>Last 7 Days ▾</button>
                <button style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "5px 12px", fontSize: 12, color: "#64748b", cursor: "pointer" }}>↓ Export</button>
              </div>
            </div>
            <div style={{ height: 190, marginTop: 20 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0d7c5f" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0d7c5f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(val: any) => [`${val} USDC`, "Volume"]} />
                  <Area type="monotone" dataKey="volume" stroke="#0d7c5f" strokeWidth={2.5} fill="url(#mainGrad)" dot={{ fill: "#0d7c5f", r: 4, strokeWidth: 0 }} activeDot={{ r: 6, fill: "#0d7c5f" }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginTop: 18, paddingTop: 18, borderTop: "1px solid #f1f5f9" }}>
              {[
                { label: "Successful", value: successCount, color: "#0d7c5f", bg: "#f0fdf4", border: "#bbf7d0", icon: "✓" },
                { label: "Failed", value: failedCount, color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "✗" },
                { label: "Rate", value: `${metrics.successRate.toFixed(1)}%`, color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe", icon: "◎" },
                { label: "Avg Value", value: `$${avgTxValue.toFixed(2)}`, color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "↗" },
              ].map((m, i) => (
                <div key={i} style={{ background: m.bg, border: `1px solid ${m.border}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
                    <span style={{ color: m.color, fontSize: 11 }}>{m.icon}</span>
                    <p style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase", margin: 0 }}>{m.label}</p>
                  </div>
                  <p style={{ fontSize: 17, fontWeight: 700, color: m.color, fontFamily: "monospace", margin: 0 }}>{m.value}</p>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 24, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#0f172a", margin: 0 }}>Gateway Overview</h3>
              <div style={{ display: "flex", alignItems: "center", gap: 5, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 20, padding: "3px 10px" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 600 }}>Live</span>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 4px 0" }}>Total Revenue (USDC)</p>
            <p style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", fontFamily: "monospace", margin: "0 0 2px 0" }}>
              {metrics.totalVolume.toFixed(2)} <span style={{ fontSize: 14, color: "#0d7c5f" }}>USDC</span>
            </p>
            <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 20px 0" }}>≈ ${metrics.totalVolume.toFixed(2)}</p>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Successful Payments</p>
                <p style={{ fontSize: 12, color: "#0f172a", fontWeight: 600, margin: 0 }}>{metrics.successRate.toFixed(1)}%</p>
              </div>
              <p style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", fontFamily: "monospace", margin: "0 0 8px 0" }}>{successCount}</p>
              <div style={{ height: 5, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${metrics.successRate}%`, background: "linear-gradient(90deg,#0d7c5f,#16a34a)", borderRadius: 3 }} />
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Failed Payments</p>
                <p style={{ fontSize: 12, color: "#0f172a", fontWeight: 600, margin: 0 }}>{(100 - metrics.successRate).toFixed(1)}%</p>
              </div>
              <p style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", fontFamily: "monospace", margin: "0 0 8px 0" }}>{failedCount}</p>
              <div style={{ height: 5, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${100 - metrics.successRate}%`, background: "#dc2626", borderRadius: 3 }} />
              </div>
            </div>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <p style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1, margin: "0 0 2px 0" }}>ERC-8004 Agent Pipeline</p>
              <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 10px 0" }}>Programmatically instantiate sandboxed SCA nodes</p>
              <button onClick={triggerAgentLifecycle} disabled={isDeploying} style={{ width: "100%", padding: "9px 0", borderRadius: 8, background: isDeploying ? "#f1f5f9" : "rgba(13,124,95,0.08)", border: `1px solid ${isDeploying ? "#e2e8f0" : "rgba(13,124,95,0.3)"}`, color: isDeploying ? "#94a3b8" : "#0d7c5f", fontSize: 11, fontWeight: 700, cursor: isDeploying ? "not-allowed" : "pointer", letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace" }}>
                {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT LIFECYCLE"}
              </button>
              {deploymentError && <p style={{ color: "#dc2626", fontSize: 10, marginTop: 6, margin: "6px 0 0 0" }}>❌ {deploymentError}</p>}
              {deployedAgent && <p style={{ color: "#0d7c5f", fontSize: 10, marginTop: 6, margin: "6px 0 0 0" }}>● Live Agent Registry Bound</p>}
            </div>
            <button onClick={() => { navigator.clipboard.writeText("arc_live_fa8d822ac7713302ea287a183a15cacdbfcb5d1a5477fae2"); alert("API Key copied!"); }} style={{ width: "100%", padding: "12px 0", fontSize: 13, background: "#0d7c5f", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 600 }}>
              🔑 Generate API Key →
            </button>
          </div>
        </div>

        {/* Settlement Table */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-base font-bold tracking-wide uppercase font-mono text-white">Inbound Agent Settlement Streams</h3>
            <span className="text-xs text-gray-500 font-mono bg-[#120b08] px-3 py-1 rounded-lg border border-[#3a2a20]">Prisma Database Synchronization</span>
          </div>
          {error && <div className="text-red-400 text-xs font-mono mb-4">❌ {error}</div>}
          {payments.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-sm font-mono">No settlement streams recorded yet.</p>
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
                        <div className="text-gray-500 text-[10px] mt-0.5">{new Date(payment.paid_at).toLocaleString()}</div>
                      </td>
                      <td className="py-4 pr-4">
                        <div className="text-gray-300">{payment.sender_email}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">→ Merchant: {payment.merchant}</div>
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
                        <span className={`px-2 py-1 rounded text-[10px] font-bold border ${payment.status === "SUCCESS" ? "bg-green-500/10 text-green-400 border-green-500/20" : payment.status === "ATTESTATION_FAILED" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>
                          {payment.status === "SUCCESS" ? "SUCCESS" : payment.status === "ATTESTATION_FAILED" ? "FAILED" : "PENDING"}
                        </span>
                      </td>
                      <td className="py-4">
                        <div className={`text-[10px] ${payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED" ? "text-green-400" : "text-amber-400"}`}>
                          {payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED" ? "REDEEMED_AND_MINTED" : "POLLING_CIRCLE_TESTNET_IRIS_API"}
                        </div>
                        <div className="text-gray-600 text-[10px] mt-0.5">Nonce: {payment.cctp_telemetry.nonce}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}
