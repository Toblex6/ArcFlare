"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────
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
    attestation_status: string;
    nonce: number;
  };
}

interface DashboardMetrics {
  totalVolume: number;
  successRate: number;
  totalTransactions: number;
}

// ─── Sidebar Nav ──────────────────────────────────────────────────────────────
const navItems = [
  { label: "Dashboard", icon: "▦", href: "/dashboard", active: true },
  { label: "Payments", icon: "↔", href: "/payments" },
  { label: "Transactions", icon: "≡", href: "/transactions" },
  { label: "Merchants", icon: "⊕", href: "/merchants" },
  { label: "Wallets", icon: "◎", href: "/wallets" },
  { label: "Analytics", icon: "↗", href: "/analytics" },
  { label: "Webhooks", icon: "⟳", href: "/webhooks" },
  { label: "Settings", icon: "⚙", href: "/settings" },
];

// ─── Sparkline data generator ─────────────────────────────────────────────────
function generateSparkline(base: number, points = 8) {
  return Array.from({ length: points }, (_, i) => ({
    v: base + Math.sin(i * 0.8) * base * 0.15 + Math.random() * base * 0.1,
  }));
}

export default function DashboardV2() {
  const router = useRouter();
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalVolume: 0,
    successRate: 100,
    totalTransactions: 0,
  });
  const [loading, setLoading] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployedAgent, setDeployedAgent] = useState<any>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [notifications] = useState(3);
  const [chartData, setChartData] = useState<any[]>([]);

  const fetchData = async (silent = false) => {
    try {
      const res = await fetch("/api/payments/all");
      const json = await res.json();
      if (json.status) {
        setPayments(json.data);
        setMetrics(json.metrics);

        // Build chart from real transaction data grouped by day
        const grouped: Record<string, number> = {};
        json.data.forEach((p: PaymentItem) => {
          const day = new Date(p.paid_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          grouped[day] = (grouped[day] || 0) + p.amount;
        });

        const days = Object.entries(grouped)
          .slice(-7)
          .map(([date, volume]) => ({ date, volume }));

        // Pad to 7 days if fewer
        if (days.length < 2) {
          const today = new Date();
          const padded = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() - (6 - i));
            return {
              date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
              volume: 0,
            };
          });
          padded[padded.length - 1].volume = json.metrics.totalVolume;
          setChartData(padded);
        } else {
          setChartData(days);
        }
      }
    } catch (e) {
      if (!silent) console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const triggerAgentLifecycle = async () => {
    setIsDeploying(true);
    setDeployError(null);
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
      if (!res.ok || data.error) throw new Error(data.error || "Lifecycle failed.");
      setDeployedAgent(data);
      fetchData(true);
    } catch (err: any) {
      setDeployError(err.message);
    } finally {
      setIsDeploying(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(true), 8000);
    return () => clearInterval(interval);
  }, []);

  const successCount = payments.filter((p) => p.status === "SUCCESS").length;
  const failedCount = payments.filter((p) => p.status !== "SUCCESS").length;
  const avgTxValue = payments.length > 0 ? metrics.totalVolume / payments.length : 0;

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh", background: "#0f1117",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 40, height: 40, border: "3px solid #0d7c5f",
            borderTopColor: "transparent", borderRadius: "50%",
            animation: "spin 0.8s linear infinite", margin: "0 auto 16px",
          }} />
          <p style={{ color: "#4b5563", fontFamily: "monospace", fontSize: 12, letterSpacing: 2 }}>
            SYNCING LEDGER...
          </p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#0f1117", color: "#e2e8f0", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0f1117; }
        ::-webkit-scrollbar-thumb { background: #1e2535; border-radius: 2px; }
        .nav-item { transition: all 0.15s ease; cursor: pointer; }
        .nav-item:hover { background: rgba(13,124,95,0.1) !important; color: #0d7c5f !important; }
        .card { transition: transform 0.2s ease, box-shadow 0.2s ease; }
        .card:hover { transform: translateY(-1px); box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important; }
        .btn-primary { transition: all 0.15s ease; }
        .btn-primary:hover { background: #0a6b50 !important; transform: translateY(-1px); }
        .action-btn { transition: all 0.15s ease; opacity: 0.6; cursor: pointer; }
        .action-btn:hover { opacity: 1; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.4s ease forwards; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>

      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <aside style={{
        width: 220, background: "#0a0d13", borderRight: "1px solid #1a2235",
        display: "flex", flexDirection: "column", padding: "24px 0", flexShrink: 0,
        position: "sticky", top: 0, height: "100vh", overflowY: "auto",
      }}>
        {/* Logo */}
        <div style={{ padding: "0 20px 28px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 32, height: 32, background: "linear-gradient(135deg, #0d7c5f, #0a5c47)",
              borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700, color: "#fff",
            }}>A</div>
            <span style={{ fontWeight: 700, fontSize: 18, color: "#fff", letterSpacing: -0.5 }}>ArcFlare</span>
          </div>
          <p style={{ fontSize: 10, color: "#4b5563", letterSpacing: 0.5, paddingLeft: 42 }}>
            Stablecoin Payment Infrastructure
          </p>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "0 12px" }}>
          {navItems.map((item) => (
            <div
              key={item.label}
              className="nav-item"
              onClick={() => router.push(item.href)}
              style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 12px", borderRadius: 8, marginBottom: 2,
                background: item.active ? "rgba(13,124,95,0.15)" : "transparent",
                color: item.active ? "#0d7c5f" : "#6b7280",
                fontSize: 14, fontWeight: item.active ? 600 : 400,
                borderLeft: item.active ? "2px solid #0d7c5f" : "2px solid transparent",
              }}
            >
              <span style={{ fontSize: 16, width: 20, textAlign: "center" }}>{item.icon}</span>
              {item.label}
            </div>
          ))}
        </nav>

        {/* Balance Card */}
        <div style={{ margin: "16px 12px", padding: 16, background: "linear-gradient(135deg, #0d7c5f22, #0a5c4711)", border: "1px solid #0d7c5f33", borderRadius: 12 }}>
          <p style={{ fontSize: 10, color: "#6b7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>Total Balance</p>
          <p style={{ fontSize: 22, fontWeight: 700, color: "#fff", fontFamily: "'DM Mono', monospace" }}>
            {metrics.totalVolume.toFixed(2)} <span style={{ fontSize: 12, color: "#0d7c5f" }}>USDC</span>
          </p>
          <p style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>≈ ${metrics.totalVolume.toFixed(2)}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, cursor: "pointer" }}>
            <div style={{ width: 20, height: 20, background: "#0d7c5f", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}>$</div>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>USDC Wallet</span>
            <span style={{ marginLeft: "auto", color: "#0d7c5f", fontSize: 12 }}>→</span>
          </div>
        </div>

        {/* Get Started Card */}
        <div style={{ margin: "0 12px 16px", padding: 16, background: "linear-gradient(135deg, #0d7c5f, #0a5c47)", borderRadius: 12 }}>
          <div style={{ fontSize: 20, marginBottom: 8 }}>🚀</div>
          <p style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 4 }}>Start Accepting Stablecoins Today</p>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginBottom: 12, lineHeight: 1.5 }}>Simple, secure and scalable infrastructure for modern payments.</p>
          <button onClick={() => router.push("/checkout")} style={{
            width: "100%", padding: "8px 0", background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8,
            color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>Get Started →</button>
        </div>

        <div style={{ padding: "12px 24px", borderTop: "1px solid #1a2235" }}>
          <div className="nav-item" style={{ display: "flex", alignItems: "center", gap: 8, color: "#4b5563", fontSize: 13, padding: "8px 0", borderRadius: 6 }}>
            <span>?</span> Help & Support
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT ─────────────────────────────────────────────────── */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>

        {/* Top Bar */}
        <header style={{
          height: 64, borderBottom: "1px solid #1a2235", display: "flex",
          alignItems: "center", padding: "0 32px", gap: 16, background: "#0a0d13",
          position: "sticky", top: 0, zIndex: 10,
        }}>
          {/* Search */}
          <div style={{
            flex: 1, maxWidth: 400, display: "flex", alignItems: "center", gap: 10,
            background: "#0f1117", border: "1px solid #1a2235", borderRadius: 10,
            padding: "8px 14px",
          }}>
            <span style={{ color: "#4b5563", fontSize: 14 }}>🔍</span>
            <input placeholder="Search anything..." style={{
              background: "none", border: "none", outline: "none",
              color: "#9ca3af", fontSize: 13, flex: 1,
            }} />
            <span style={{ color: "#4b5563", fontSize: 11, background: "#1a2235", padding: "2px 6px", borderRadius: 4 }}>⌘K</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
            {/* Connect Wallet */}
            <button onClick={() => router.push("/wallets")} style={{
              padding: "8px 16px", background: "transparent",
              border: "1px solid #1a2235", borderRadius: 8,
              color: "#9ca3af", fontSize: 13, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <span>◎</span> Connect Wallet
            </button>

            {/* Open Checkout */}
            <button className="btn-primary" onClick={() => router.push("/checkout")} style={{
              padding: "8px 16px", background: "#0d7c5f",
              border: "none", borderRadius: 8,
              color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              🛒 Open Checkout
            </button>

            {/* Notifications */}
            <div style={{ position: "relative", cursor: "pointer" }}>
              <div style={{ width: 36, height: 36, background: "#0f1117", border: "1px solid #1a2235", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🔔</div>
              {notifications > 0 && (
                <div style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, background: "#0d7c5f", borderRadius: "50%", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700 }}>
                  {notifications}
                </div>
              )}
            </div>

            {/* User */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <div style={{ width: 36, height: 36, background: "linear-gradient(135deg, #0d7c5f, #0a5c47)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff" }}>MA</div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>Merchant Admin</p>
                <p style={{ fontSize: 11, color: "#4b5563" }}>Admin</p>
              </div>
              <span style={{ color: "#4b5563", fontSize: 12 }}>▾</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div style={{ padding: "32px", flex: 1 }} className="fade-in">

          {/* Welcome + Date */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: "#fff", marginBottom: 4 }}>
                Welcome back, Merchant Admin 👋
              </h1>
              <p style={{ fontSize: 14, color: "#6b7280" }}>Here's what's happening with your business today.</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0f1117", border: "1px solid #1a2235", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
              <span style={{ fontSize: 14 }}>📅</span>
              <span style={{ fontSize: 13, color: "#9ca3af" }}>{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
              <span style={{ color: "#4b5563", fontSize: 12 }}>▾</span>
            </div>
          </div>

          {/* ── METRIC CARDS ──────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
            {[
              { label: "Total Volume", value: `${metrics.totalVolume.toFixed(2)} USDC`, change: "+18%", icon: "$", color: "#0d7c5f", data: generateSparkline(metrics.totalVolume || 1) },
              { label: "Transactions", value: metrics.totalTransactions.toString(), change: "+12%", icon: "↔", color: "#8b5cf6", data: generateSparkline(metrics.totalTransactions || 1) },
              { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, change: "+3%", icon: "✓", color: "#f59e0b", data: generateSparkline(metrics.successRate || 1) },
              { label: "Avg Tx Value", value: `${avgTxValue.toFixed(2)} USDC`, change: "+11%", icon: "↗", color: "#3b82f6", data: generateSparkline(avgTxValue || 1) },
            ].map((card, i) => (
              <div key={i} className="card" style={{ background: "#0f1117", border: "1px solid #1a2235", borderRadius: 14, padding: 20, boxShadow: "0 4px 16px rgba(0,0,0,0.3)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 36, height: 36, background: `${card.color}22`, border: `1px solid ${card.color}44`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: card.color }}>
                    {card.icon}
                  </div>
                  <div>
                    <p style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{card.label}</p>
                    <span style={{ fontSize: 11, color: "#0d7c5f", fontWeight: 600 }}>{card.change}</span>
                  </div>
                </div>
                <p style={{ fontSize: 22, fontWeight: 700, color: "#fff", fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>{card.value}</p>
                <p style={{ fontSize: 11, color: "#4b5563", marginBottom: 8 }}>vs last week</p>
                <ResponsiveContainer width="100%" height={40}>
                  <AreaChart data={card.data}>
                    <defs>
                      <linearGradient id={`grad${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={card.color} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={card.color} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="v" stroke={card.color} strokeWidth={1.5} fill={`url(#grad${i})`} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ))}
          </div>

          {/* ── ANALYTICS + GATEWAY OVERVIEW ─────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, marginBottom: 24 }}>

            {/* Chart */}
            <div style={{ background: "#0f1117", border: "1px solid #1a2235", borderRadius: 14, padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>Payment Analytics</h3>
                  <p style={{ fontSize: 12, color: "#6b7280" }}>Stablecoin transaction activity</p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ padding: "6px 12px", background: "#0f1117", border: "1px solid #1a2235", borderRadius: 6, color: "#9ca3af", fontSize: 12, cursor: "pointer" }}>
                    Last 7 Days ▾
                  </button>
                  <button style={{ padding: "6px 12px", background: "#0f1117", border: "1px solid #1a2235", borderRadius: 6, color: "#9ca3af", fontSize: 12, cursor: "pointer" }}>
                    ↓ Export
                  </button>
                  <button style={{ padding: "6px 12px", background: "#0f1117", border: "1px solid #1a2235", borderRadius: 6, color: "#9ca3af", fontSize: 12, cursor: "pointer" }}>
                    ⋯
                  </button>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0d7c5f" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#0d7c5f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a2235" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#4b5563", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#4b5563", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "#0a0d13", border: "1px solid #1a2235", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#9ca3af" }}
                    itemStyle={{ color: "#0d7c5f" }}
                  />
                  <Area type="monotone" dataKey="volume" stroke="#0d7c5f" strokeWidth={2.5} fill="url(#mainGrad)" dot={{ fill: "#0d7c5f", r: 4, strokeWidth: 0 }} activeDot={{ r: 6, fill: "#0d7c5f" }} />
                </AreaChart>
              </ResponsiveContainer>

              {/* Sub metrics */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16, paddingTop: 16, borderTop: "1px solid #1a2235" }}>
                {[
                  { label: "Successful Payments", value: successCount, change: "+15%", up: true, icon: "✓", color: "#0d7c5f" },
                  { label: "Failed Payments", value: failedCount, change: "-8%", up: false, icon: "✗", color: "#ef4444" },
                  { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, change: "+3%", up: true, icon: "◎", color: "#3b82f6" },
                  { label: "Avg Txn Value", value: `$${avgTxValue.toFixed(2)}`, change: "+11%", up: true, icon: "↗", color: "#f59e0b" },
                ].map((m, i) => (
                  <div key={i} style={{ padding: 12, background: "#0a0d13", borderRadius: 8, border: "1px solid #1a2235" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: 14, color: m.color }}>{m.icon}</span>
                      <p style={{ fontSize: 10, color: "#6b7280" }}>{m.label}</p>
                    </div>
                    <p style={{ fontSize: 18, fontWeight: 700, color: "#fff", fontFamily: "'DM Mono', monospace" }}>{m.value}</p>
                    <p style={{ fontSize: 11, color: m.up ? "#0d7c5f" : "#ef4444", marginTop: 2 }}>
                      {m.up ? "↑" : "↓"} {m.change}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Gateway Overview */}
            <div style={{ background: "#0f1117", border: "1px solid #1a2235", borderRadius: 14, padding: 24, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h3 style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>Gateway Overview</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0d7c5f11", border: "1px solid #0d7c5f33", borderRadius: 20, padding: "3px 10px" }}>
                  <span style={{ width: 6, height: 6, background: "#0d7c5f", borderRadius: "50%", animation: "pulse 2s infinite" }} />
                  <span style={{ fontSize: 11, color: "#0d7c5f", fontWeight: 600 }}>Live</span>
                </div>
              </div>

              <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>Total Revenue (USDC)</p>
              <p style={{ fontSize: 32, fontWeight: 700, color: "#fff", fontFamily: "'DM Mono', monospace", marginBottom: 2 }}>
                {metrics.totalVolume.toFixed(2)} <span style={{ fontSize: 16, color: "#0d7c5f" }}>USDC</span>
              </p>
              <p style={{ fontSize: 12, color: "#4b5563", marginBottom: 24 }}>≈ ${metrics.totalVolume.toFixed(2)}</p>

              {/* Successful */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <p style={{ fontSize: 12, color: "#6b7280" }}>Successful Payments</p>
                  <p style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{metrics.successRate.toFixed(1)}%</p>
                </div>
                <p style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 8, fontFamily: "'DM Mono', monospace" }}>{successCount}</p>
                <div style={{ height: 6, background: "#1a2235", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${metrics.successRate}%`, background: "linear-gradient(90deg, #0d7c5f, #10b981)", borderRadius: 3, transition: "width 1s ease" }} />
                </div>
              </div>

              {/* Failed */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <p style={{ fontSize: 12, color: "#6b7280" }}>Failed Payments</p>
                  <p style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{(100 - metrics.successRate).toFixed(1)}%</p>
                </div>
                <p style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 8, fontFamily: "'DM Mono', monospace" }}>{failedCount}</p>
                <div style={{ height: 6, background: "#1a2235", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${100 - metrics.successRate}%`, background: "#ef4444", borderRadius: 3 }} />
                </div>
              </div>

              {/* Agent Pipeline */}
              <div style={{ padding: 14, background: "#0a0d13", border: "1px solid #1a2235", borderRadius: 10, marginBottom: 16 }}>
                <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>ERC-8004 Agent Pipeline</p>
                <button
                  onClick={triggerAgentLifecycle}
                  disabled={isDeploying}
                  style={{
                    width: "100%", padding: "8px 0", marginTop: 8,
                    background: isDeploying ? "#1a2235" : "transparent",
                    border: `1px solid ${isDeploying ? "#1a2235" : "#0d7c5f"}`,
                    borderRadius: 6, color: isDeploying ? "#4b5563" : "#0d7c5f",
                    fontSize: 11, fontWeight: 600, cursor: isDeploying ? "not-allowed" : "pointer",
                    letterSpacing: 1, textTransform: "uppercase",
                  }}
                >
                  {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT"}
                </button>
                {deployError && <p style={{ color: "#ef4444", fontSize: 10, marginTop: 6 }}>❌ {deployError}</p>}
                {deployedAgent && <p style={{ color: "#0d7c5f", fontSize: 10, marginTop: 6 }}>● Agent bound successfully</p>}
              </div>

              {/* Generate API Key */}
              <button
                className="btn-primary"
                onClick={() => {
                  navigator.clipboard.writeText("arc_live_fa8d822ac7713302ea287a183a15cacdbfcb5d1a5477fae2");
                  alert("API Key copied to clipboard!");
                }}
                style={{
                  width: "100%", padding: "12px 0", background: "#0d7c5f",
                  border: "none", borderRadius: 10, color: "#fff",
                  fontSize: 13, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  marginTop: "auto",
                }}
              >
                🔑 Generate API Key →
              </button>
            </div>
          </div>

          {/* ── RECENT TRANSACTIONS ───────────────────────────────────────── */}
          <div style={{ background: "#0f1117", border: "1px solid #1a2235", borderRadius: 14, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>Recent Transactions</h3>
              <button onClick={() => router.push("/transactions")} style={{ background: "none", border: "none", color: "#0d7c5f", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                View all →
              </button>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1a2235" }}>
                  {["Transaction ID", "Type", "Amount", "Status", "Date", "Merchant", "Actions"].map((h) => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 11, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payments.slice(0, 8).map((payment, i) => (
                  <tr key={payment.id} style={{ borderBottom: "1px solid #0f1117", transition: "background 0.15s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#0a0d13")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "14px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "#9ca3af", fontFamily: "'DM Mono', monospace" }}>
                          {payment.reference.slice(0, 18)}...
                        </span>
                        <span className="action-btn" style={{ fontSize: 12, color: "#4b5563" }} onClick={() => navigator.clipboard.writeText(payment.reference)}>⧉</span>
                      </div>
                    </td>
                    <td style={{ padding: "14px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14, color: "#0d7c5f" }}>↔</span>
                        <span style={{ fontSize: 13, color: "#9ca3af" }}>Payment</span>
                      </div>
                    </td>
                    <td style={{ padding: "14px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 18, height: 18, background: "#0d7c5f22", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#0d7c5f" }}>$</div>
                        <span style={{ fontSize: 13, color: "#fff", fontFamily: "'DM Mono', monospace" }}>{payment.amount.toFixed(2)} {payment.currency}</span>
                      </div>
                    </td>
                    <td style={{ padding: "14px 12px" }}>
                      <span style={{
                        padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                        background: payment.status === "SUCCESS" ? "#0d7c5f22" : "#ef444422",
                        color: payment.status === "SUCCESS" ? "#0d7c5f" : "#ef4444",
                        border: `1px solid ${payment.status === "SUCCESS" ? "#0d7c5f44" : "#ef444444"}`,
                      }}>
                        ● {payment.status === "SUCCESS" ? "Completed" : payment.status}
                      </span>
                    </td>
                    <td style={{ padding: "14px 12px" }}>
                      <span style={{ fontSize: 12, color: "#6b7280" }}>
                        {new Date(payment.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </td>
                    <td style={{ padding: "14px 12px" }}>
                      <span style={{ fontSize: 13, color: "#9ca3af" }}>{payment.merchant}</span>
                    </td>
                    <td style={{ padding: "14px 12px" }}>
                      <button className="action-btn" style={{ background: "none", border: "none", color: "#4b5563", fontSize: 18, cursor: "pointer" }}>⋯</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {payments.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 0", color: "#4b5563" }}>
                <p style={{ fontSize: 14 }}>No transactions yet</p>
                <p style={{ fontSize: 12, marginTop: 4 }}>Payments will appear here after checkout</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
