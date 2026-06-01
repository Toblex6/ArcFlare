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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
        throw new Error(json.error || "Failed to load data.");
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#0f1117" }}>
        <p className="text-sm font-mono uppercase tracking-widest animate-pulse" style={{ color: "#0d7c5f" }}>
          SYNCING TESTNET TELEMETRY INSTANCE...
        </p>
      </div>
    );
  }

  const navItems = [
    {
      label: "Dashboard",
      icon: (
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
      ),
      href: "/dashboard",
      active: true,
    },
    {
      label: "Homepage",
      icon: (
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M3 12L12 3l9 9"/><path d="M9 21V12h6v9"/>
        </svg>
      ),
      href: "/",
      active: false,
    },
    {
      label: "Checkout",
      icon: (
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
        </svg>
      ),
      href: "/checkout",
      active: false,
    },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#0f1117", color: "#e2e8f0" }}>

      <style>{`
        .dash-card { background: #1a2235; border: 1px solid #232d42; border-radius: 16px; }
        .dash-card-inner { background: #111827; border: 1px solid #1e2a3a; border-radius: 12px; }
        .green { color: #0d7c5f; }
        .green-bg { background: #0d7c5f; }
        .green-subtle { background: rgba(13,124,95,0.12); border: 1px solid rgba(13,124,95,0.25); }
        .green-subtle-text { color: #10b981; }
        .muted { color: #6b7280; }
        .red { color: #ef4444; }
        .amber { color: #f59e0b; }
        .mono { font-family: 'DM Mono', 'Courier New', monospace; }
        .hover-row:hover { background: rgba(255,255,255,0.03); }
        .btn-green { background: #0d7c5f; color: #fff; border: none; border-radius: 10px; cursor: pointer; font-weight: 600; transition: background 0.15s; }
        .btn-green:hover { background: #0a6b50; }
        .btn-outline { background: transparent; border: 1px solid #232d42; border-radius: 10px; cursor: pointer; color: #9ca3af; transition: all 0.15s; }
        .btn-outline:hover { border-color: #0d7c5f; color: #0d7c5f; }
        .nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; cursor: pointer; transition: all 0.15s; text-decoration: none; color: #6b7280; font-size: 13px; font-weight: 500; }
        .nav-item:hover { background: rgba(13,124,95,0.08); color: #e2e8f0; }
        .nav-item.active { background: rgba(13,124,95,0.15); color: #0d7c5f; border: 1px solid rgba(13,124,95,0.2); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .pulse { animation: pulse 2s infinite; }
        .sidebar-toggle:hover { background: rgba(255,255,255,0.05); }
      `}</style>

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside style={{
        width: sidebarCollapsed ? 64 : 220,
        minHeight: "100vh",
        background: "#0d1117",
        borderRight: "1px solid #1e2a3a",
        display: "flex",
        flexDirection: "column",
        padding: sidebarCollapsed ? "20px 10px" : "20px 14px",
        transition: "width 0.2s ease",
        flexShrink: 0,
      }}>

        {/* Logo + collapse button */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
          {!sidebarCollapsed && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 28, height: 28, background: "rgba(13,124,95,0.2)", border: "1px solid rgba(13,124,95,0.4)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: "#0d7c5f", fontSize: 14, fontWeight: 800 }}>A</span>
              </div>
              <div>
                <p style={{ color: "#fff", fontSize: 13, fontWeight: 700, lineHeight: 1 }}>ArcFlare</p>
                <p style={{ color: "#4b5563", fontSize: 9, marginTop: 2 }}>Payment Infrastructure</p>
              </div>
            </div>
          )}
          {sidebarCollapsed && (
            <div style={{ width: 28, height: 28, background: "rgba(13,124,95,0.2)", border: "1px solid rgba(13,124,95,0.4)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
              <span style={{ color: "#0d7c5f", fontSize: 14, fontWeight: 800 }}>A</span>
            </div>
          )}
          {!sidebarCollapsed && (
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(true)}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "#4b5563", padding: 4, borderRadius: 6 }}
            >
              ◀
            </button>
          )}
        </div>

        {/* Nav items */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          {navItems.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className={`nav-item${item.active ? " active" : ""}`}
              title={sidebarCollapsed ? item.label : undefined}
              style={sidebarCollapsed ? { justifyContent: "center", padding: "10px 0" } : {}}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              {!sidebarCollapsed && <span>{item.label}</span>}
            </a>
          ))}
        </nav>

        {/* Expand button when collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            style={{ background: "transparent", border: "1px solid #1e2a3a", borderRadius: 8, cursor: "pointer", color: "#4b5563", padding: "6px 0", marginTop: 12, width: "100%" }}
          >
            ▶
          </button>
        )}

        {/* Testnet badge */}
        {!sidebarCollapsed && (
          <div style={{ marginTop: 16, background: "rgba(13,124,95,0.06)", border: "1px solid rgba(13,124,95,0.15)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span className="pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#0d7c5f", display: "inline-block" }} />
              <span style={{ fontSize: 9, color: "#0d7c5f", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Arc Testnet</span>
            </div>
            <p style={{ fontSize: 9, color: "#374151", lineHeight: 1.4 }}>Connected to live cloud ledger</p>
          </div>
        )}
      </aside>

      {/* ── MAIN CONTENT ─────────────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: "24px 28px", overflowX: "hidden" }}>

        {/* Warning Banner */}
        <div style={{ marginBottom: 20, background: "rgba(13,124,95,0.08)", border: "1px solid rgba(13,124,95,0.2)", borderRadius: 12, padding: "10px 20px", textAlign: "center" }}>
          <p className="mono" style={{ fontSize: 11, color: "#0d7c5f", letterSpacing: 1, textTransform: "uppercase" }}>
            ⚠ ArcFlare Ecosystem Monitoring Node — Running on{" "}
            <span style={{ textDecoration: "underline", fontWeight: 700 }}>Arc Testnet Mode</span>.
            Connected to Live Cloud Ledger.
          </p>
        </div>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #1e2a3a", paddingBottom: 20, marginBottom: 28 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 4 }}>ArcFlare Merchant Terminal</h1>
            <p style={{ fontSize: 13, color: "#6b7280" }}>Here's what's happening with your network today.</p>
          </div>
          <div className="green-subtle" style={{ borderRadius: 20, padding: "5px 14px", display: "flex", alignItems: "center", gap: 6 }}>
            <span className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#0d7c5f", display: "inline-block" }} />
            <span className="mono" style={{ fontSize: 11, color: "#0d7c5f", fontWeight: 600, letterSpacing: 1 }}>LIVE NETWORK NODE ACTIVE</span>
          </div>
        </div>

        {/* METRIC CARDS */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
          {[
            { label: "Testnet Volume Settled", value: metrics.totalVolume.toFixed(2), unit: "tUSDC", unitColor: "#f59e0b", icon: "$", iconBg: "rgba(13,124,95,0.15)", iconColor: "#0d7c5f", dataKey: "volume", strokeColor: "#0d7c5f" },
            { label: "Total M2M Operations", value: metrics.totalTransactions.toString(), unit: "Recorded Tx", unitColor: "#6b7280", icon: "↔", iconBg: "rgba(139,92,246,0.15)", iconColor: "#8b5cf6", dataKey: "count", strokeColor: "#8b5cf6" },
            { label: "CCTP Attestation Precision", value: `${metrics.successRate.toFixed(1)}%`, unit: `${successCount} settled`, unitColor: "#10b981", icon: "◎", iconBg: "rgba(16,185,129,0.15)", iconColor: "#10b981", dataKey: "volume", strokeColor: "#10b981" },
          ].map((card, i) => (
            <div key={i} className="dash-card" style={{ padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <div style={{ width: 36, height: 36, background: card.iconBg, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: card.iconColor }}>{card.icon}</div>
                <p style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{card.label}</p>
              </div>
              <p className="mono" style={{ fontSize: 28, fontWeight: 700, color: "#fff", marginBottom: 4 }}>
                {card.value}{" "}<span style={{ fontSize: 13, fontWeight: 400, color: card.unitColor }}>{card.unit}</span>
              </p>
              {chartData.length > 0 && (
                <div style={{ height: 44, marginTop: 12 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id={`sg${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={card.strokeColor} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={card.strokeColor} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey={card.dataKey} stroke={card.strokeColor} strokeWidth={1.5} fill={`url(#sg${i})`} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* CHART + GATEWAY OVERVIEW */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, marginBottom: 24 }}>

          <div className="dash-card" style={{ padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>Payment Analytics</h3>
                <p style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Stablecoin transaction activity</p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-outline" style={{ padding: "6px 12px", fontSize: 12 }}>Last 7 Days ▾</button>
                <button className="btn-outline" style={{ padding: "6px 12px", fontSize: 12 }}>↓ Export</button>
              </div>
            </div>
            <div style={{ height: 200, marginTop: 20 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0d7c5f" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#0d7c5f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2a3a" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#4b5563", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#4b5563", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "#111827", border: "1px solid #232d42", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#9ca3af" }}
                    itemStyle={{ color: "#0d7c5f" }}
                    formatter={(val: any) => [`${val} USDC`, "Volume"]}
                  />
                  <Area type="monotone" dataKey="volume" stroke="#0d7c5f" strokeWidth={2.5} fill="url(#mainGrad)" dot={{ fill: "#0d7c5f", r: 4, strokeWidth: 0 }} activeDot={{ r: 6, fill: "#0d7c5f" }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginTop: 20, paddingTop: 20, borderTop: "1px solid #1e2a3a" }}>
              {[
                { label: "Successful Payments", value: successCount, color: "#0d7c5f", icon: "✓" },
                { label: "Failed Payments", value: failedCount, color: "#ef4444", icon: "✗" },
                { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, color: "#3b82f6", icon: "◎" },
                { label: "Avg Txn Value", value: `$${avgTxValue.toFixed(2)}`, color: "#f59e0b", icon: "↗" },
              ].map((m, i) => (
                <div key={i} className="dash-card-inner" style={{ padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                    <span style={{ color: m.color, fontSize: 12 }}>{m.icon}</span>
                    <p style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.3 }}>{m.label}</p>
                  </div>
                  <p className="mono" style={{ fontSize: 18, fontWeight: 700, color: m.color }}>{m.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Gateway Overview */}
          <div className="dash-card" style={{ padding: 24, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>Gateway Overview</h3>
              <div className="green-subtle" style={{ borderRadius: 20, padding: "3px 10px", display: "flex", alignItems: "center", gap: 5 }}>
                <span className="pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#0d7c5f", display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "#0d7c5f", fontWeight: 600 }}>Live</span>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>Total Revenue (USDC)</p>
            <p className="mono" style={{ fontSize: 30, fontWeight: 700, color: "#fff", marginBottom: 2 }}>
              {metrics.totalVolume.toFixed(2)}{" "}<span style={{ fontSize: 14, color: "#0d7c5f" }}>USDC</span>
            </p>
            <p style={{ fontSize: 12, color: "#4b5563", marginBottom: 24 }}>≈ ${metrics.totalVolume.toFixed(2)}</p>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <p style={{ fontSize: 12, color: "#6b7280" }}>Successful Payments</p>
                <p style={{ fontSize: 12, color: "#fff" }}>{metrics.successRate.toFixed(1)}%</p>
              </div>
              <p className="mono" style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{successCount}</p>
              <div style={{ height: 5, background: "#1e2a3a", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${metrics.successRate}%`, background: "linear-gradient(90deg, #0d7c5f, #10b981)", borderRadius: 3, transition: "width 1s ease" }} />
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <p style={{ fontSize: 12, color: "#6b7280" }}>Failed Payments</p>
                <p style={{ fontSize: 12, color: "#fff" }}>{(100 - metrics.successRate).toFixed(1)}%</p>
              </div>
              <p className="mono" style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{failedCount}</p>
              <div style={{ height: 5, background: "#1e2a3a", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${100 - metrics.successRate}%`, background: "#ef4444", borderRadius: 3 }} />
              </div>
            </div>

            <div className="dash-card-inner" style={{ padding: 14, marginBottom: 14 }}>
              <p style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>ERC-8004 Agent Pipeline</p>
              <p style={{ fontSize: 11, color: "#4b5563", marginBottom: 10 }}>Programmatically instantiate sandboxed SCA nodes</p>
              <button
                onClick={triggerAgentLifecycle}
                disabled={isDeploying}
                style={{
                  width: "100%", padding: "9px 0", borderRadius: 8,
                  background: isDeploying ? "#1e2a3a" : "rgba(13,124,95,0.15)",
                  border: `1px solid ${isDeploying ? "#232d42" : "#0d7c5f"}`,
                  color: isDeploying ? "#4b5563" : "#0d7c5f",
                  fontSize: 11, fontWeight: 700, cursor: isDeploying ? "not-allowed" : "pointer",
                  letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace",
                }}
              >
                {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT LIFECYCLE"}
              </button>
              {deploymentError && <p style={{ color: "#ef4444", fontSize: 10, marginTop: 6 }}>❌ {deploymentError}</p>}
              {deployedAgent && <p style={{ color: "#0d7c5f", fontSize: 10, marginTop: 6 }}>● Live Agent Registry Bound: #{deployedAgent.agentId}</p>}
            </div>

            <button
              className="btn-green"
              onClick={() => {
                navigator.clipboard.writeText("arc_live_fa8d822ac7713302ea287a183a15cacdbfcb5d1a5477fae2");
                alert("API Key copied!");
              }}
              style={{ width: "100%", padding: "12px 0", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              🔑 Generate API Key →
            </button>
          </div>
        </div>

        {/* SETTLEMENT STREAMS TABLE */}
        <div className="dash-card" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <h3 className="mono" style={{ fontSize: 13, fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: 1 }}>
              Inbound Agent Settlement Streams
            </h3>
            <span className="mono" style={{ fontSize: 10, color: "#4b5563", background: "#111827", padding: "4px 12px", borderRadius: 8, border: "1px solid #1e2a3a" }}>
              Prisma Database Synchronization
            </span>
          </div>

          {error && <p style={{ color: "#ef4444", fontSize: 12, fontFamily: "monospace", marginBottom: 16 }}>❌ {error}</p>}

          {payments.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <p style={{ color: "#4b5563", fontSize: 13, fontFamily: "monospace" }}>No settlement streams recorded yet.</p>
              <p style={{ color: "#374151", fontSize: 11, marginTop: 6 }}>Payments will appear here after checkout.</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "monospace" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e2a3a" }}>
                    {["Reference / Timestamp", "Entity M2M Graph", "Execution Domain", "Payload Value", "Status", "Circle CCTP Attestation"].map((h) => (
                      <th key={h} style={{ textAlign: "left", paddingBottom: 12, paddingRight: 16, fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id} className="hover-row" style={{ borderBottom: "1px solid #111827" }}>
                      <td style={{ padding: "14px 16px 14px 0" }}>
                        <div style={{ color: "#0d7c5f" }}>{payment.reference.slice(0, 16)}</div>
                        <div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>{new Date(payment.paid_at).toLocaleString()}</div>
                      </td>
                      <td style={{ padding: "14px 16px 14px 0" }}>
                        <div style={{ color: "#e2e8f0" }}>{payment.sender_email}</div>
                        <div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>→ Merchant: {payment.merchant}</div>
                      </td>
                      <td style={{ padding: "14px 16px 14px 0" }}>
                        <span style={{ background: "rgba(13,124,95,0.1)", color: "#0d7c5f", padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(13,124,95,0.25)", fontSize: 10 }}>
                          {payment.chain.length > 20 ? "Arc-L1" : payment.chain}
                        </span>
                      </td>
                      <td style={{ padding: "14px 16px 14px 0" }}>
                        <div style={{ color: "#fff", fontWeight: 700 }}>{payment.amount.toFixed(2)}</div>
                        <div style={{ color: "#f59e0b", fontSize: 10 }}>{payment.currency}</div>
                      </td>
                      <td style={{ padding: "14px 16px 14px 0" }}>
                        <span style={{
                          padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700,
                          background: payment.status === "SUCCESS" ? "rgba(13,124,95,0.15)" : payment.status === "ATTESTATION_FAILED" ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.1)",
                          color: payment.status === "SUCCESS" ? "#0d7c5f" : payment.status === "ATTESTATION_FAILED" ? "#ef4444" : "#f59e0b",
                          border: `1px solid ${payment.status === "SUCCESS" ? "rgba(13,124,95,0.3)" : payment.status === "ATTESTATION_FAILED" ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
                        }}>
                          {payment.status === "SUCCESS" ? "SUCCESS" : payment.status === "ATTESTATION_FAILED" ? "FAILED" : "PENDING"}
                        </span>
                      </td>
                      <td style={{ padding: "14px 0" }}>
                        <div style={{ color: payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED" ? "#10b981" : "#f59e0b", fontSize: 10 }}>
                          {payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED" ? "REDEEMED_AND_MINTED" : "POLLING_CIRCLE_TESTNET_IRIS_API"}
                        </div>
                        <div style={{ color: "#374151", fontSize: 10, marginTop: 2 }}>Nonce: {payment.cctp_telemetry.nonce}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
