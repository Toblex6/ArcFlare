// src/app/dashboard/page.tsx
"use client";

import Image from "next/image";
import React, { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
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

const INTERNAL_API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";

export default function MerchantDashboard() {
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    totalVolume: 0,
    successRate: 100,
    totalTransactions: 0,
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployedAgent, setDeployedAgent] = useState<any>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<any[]>([]);

  // ── Responsive state ──
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Close sidebar on mobile when route changes (if using Next.js Link)
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // ── Existing logic unchanged ──
  const fetchLiveDatabaseState = async (isSilentUpdate = false) => {
    try {
      const res = await fetch("/api/payments/all", {
        headers: { "x-api-key": INTERNAL_API_KEY },
      });
      const json = await res.json();
      if (json.status) {
        setPayments(json.data);
        setMetrics(json.metrics);
        setError(null);

        const grouped: Record<string, { volume: number; count: number }> = {};
        json.data.forEach((p: PaymentItem) => {
          const day = new Date(p.paid_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          if (!grouped[day]) grouped[day] = { volume: 0, count: 0 };
          grouped[day].volume += p.amount;
          grouped[day].count += 1;
        });

        const days = Object.entries(grouped)
          .slice(-7)
          .map(([date, d]) => ({
            date,
            volume: parseFloat(d.volume.toFixed(2)),
            count: d.count,
          }));

        if (days.length === 0) {
          const today = new Date();
          setChartData(
            Array.from({ length: 7 }, (_, i) => {
              const d = new Date(today);
              d.setDate(d.getDate() - (6 - i));
              return {
                date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                volume: 0,
                count: 0,
              };
            })
          );
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
          "x-api-key": INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          agentName: "DeFi Arbitrage Agent v1.0",
          metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei",
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error)
        throw new Error(data.error || "On-chain lifecycle execution failed.");
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
      <div
        style={{
          minHeight: "100vh",
          background: "#f8fafc",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p
          style={{
            color: "#0891b2",
            fontFamily: "monospace",
            fontSize: 13,
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          SYNCING TESTNET TELEMETRY INSTANCE...
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "#f8fafc",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {/* ── SIDEBAR ── */}
      <aside
        style={{
          width: 220,
          minHeight: "100vh",
          background: "#1f140f",
          display: "flex",
          flexDirection: "column",
          padding: "24px 14px",
          flexShrink: 0,
          // ── Responsive: fixed on mobile, slides in/out ──
          position: isMobile ? "fixed" : "sticky",
          top: 0,
          left: isMobile ? (sidebarOpen ? 0 : "-280px") : 0,
          height: "100vh",
          overflowY: "auto",
          zIndex: 1000,
          transition: "left 0.3s ease",
          borderRight: "1px solid #2d2015",
        }}
      >
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <Image
            src="/arcflare-logo.png.png"
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

        {/* ── GROUPED NAV ── */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
          {[
            {
              group: "CORE",
              items: [
                { label: "Dashboard", href: "/dashboard", active: true, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg> },
                { label: "Homepage", href: "/", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg> },
                { label: "Transactions", href: "/transactions", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg> },
                { label: "Checkout", href: "/checkout", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></svg> },
                { label: "Escrow", href: "/escrow", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg> },
              ]
            },
            {
              group: "AGENTS & COMMERCE",
              items: [
                { label: "Agents", href: "/agents", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /><line x1="12" y1="11" x2="12" y2="15" /></svg> },
                { label: "AI Agent", href: "/agent-services", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg> },
                { label: "Agent Wallets", href: "/agent-wallets", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><circle cx="7" cy="15" r="1.5" /></svg> },
                { label: "Jobs", href: "/jobs", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg> },
                { label: "Nanopayments", href: "/nano", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" /></svg> },
              ]
            },
            {
              group: "BUSINESS",
              items: [
                { label: "Payroll", href: "/payroll", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /><path d="M4 8h16" /><path d="M4 16h16" /><path d="M8 4v4" /><path d="M16 4v4" /></svg> },
                { label: "Scheduled", href: "/scheduled", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg> },
                { label: "Consumer (Flow)", href: "/consumer", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M8 12l3 3 5-6" /></svg> },
              ]
            },
            {
              group: null,
              items: [
                { label: "Support", href: "/support", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg> },
              ]
            },
          ].map((section) => (
            <div key={section.group || "support"} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {section.group && (
                <p style={{ fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 1, padding: "6px 12px 2px", margin: 0 }}>
                  {section.group}
                </p>
              )}
              {section.items.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", borderRadius: 9,
                    textDecoration: "none", fontSize: 13, fontWeight: 500,
                    transition: "all 0.15s",
                    background: item.active ? "rgba(34,211,238,0.18)" : "transparent",
                    color: item.active ? "#22d3ee" : "#6b7280",
                    border: item.active ? "1px solid rgba(34,211,238,0.25)" : "1px solid transparent",
                  }}
                  onMouseEnter={e => { if (!item.active) { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.04)"; (e.currentTarget as HTMLAnchorElement).style.color = "#d1d5db"; } }}
                  onMouseLeave={e => { if (!item.active) { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; (e.currentTarget as HTMLAnchorElement).style.color = "#6b7280"; } }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>

        {/* Total Balance card */}
        <div
          style={{
            background: "rgba(34,211,238,0.1)",
            border: "1px solid rgba(34,211,238,0.2)",
            borderRadius: 12,
            padding: "14px 14px",
            marginTop: 16,
          }}
        >
          <p
            style={{
              color: "#4b5563",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: 1,
              margin: "0 0 6px 0",
            }}
          >
            Total Balance
          </p>
          <p
            style={{
              color: "#fff",
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "monospace",
              margin: "0 0 2px 0",
            }}
          >
            {metrics.totalVolume.toFixed(2)}{" "}
            <span style={{ color: "#22d3ee", fontSize: 12 }}>USDC</span>
          </p>
          <p style={{ color: "#4b5563", fontSize: 10, margin: "0 0 10px 0" }}>
            ≈ ${metrics.totalVolume.toFixed(2)}
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(34,211,238,0.15)",
              borderRadius: 8,
              padding: "6px 10px",
            }}
          >
            <span style={{ color: "#22d3ee", fontSize: 12 }}>◎</span>
            <span style={{ color: "#22d3ee", fontSize: 11, fontWeight: 600 }}>USDC Wallet</span>
            <span style={{ color: "#22d3ee", marginLeft: "auto", fontSize: 12 }}>→</span>
          </div>
        </div>

        {/* Testnet badge */}
        <div
          style={{
            marginTop: 12,
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.15)",
            borderRadius: 10,
            padding: "8px 12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#f59e0b",
                display: "inline-block",
              }}
            />
            <span
              style={{
                fontSize: 9,
                color: "#f59e0b",
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              Arc Testnet Mode
            </span>
          </div>
        </div>
      </aside>

      {/* ── OVERLAY (mobile) ── */}
      {isMobile && sidebarOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 999,
          }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── MAIN CONTENT ── */}
      <main style={{ flex: 1, padding: isMobile ? "16px" : "32px", overflowX: "hidden", background: "#f8fafc" }}>
        {/* Header with hamburger */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 28,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {isMobile && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  style={{
                    background: "transparent",
                    border: "none",
                    fontSize: 24,
                    color: "#0f172a",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  ☰
                </button>
              )}
              <div>
                <h1 style={{ fontSize: "clamp(20px, 4vw, 28px)", fontWeight: 700, color: "#0f172a", margin: "0 0 4px 0" }}>
                  Welcome back, Merchant Admin 👋
                </h1>
                <p style={{ color: "#64748b", fontSize: "clamp(12px, 1.5vw, 16px)", margin: 0 }}>
                  Here's what's happening with your business today.
                </p>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "7px 14px",
                fontSize: "clamp(11px, 1vw, 14px)",
                color: "#64748b",
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              }}
            >
              📅{" "}
              {new Date().toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "rgba(8,145,178,0.08)",
                border: "1px solid rgba(8,145,178,0.2)",
                borderRadius: 10,
                padding: "7px 14px",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#0891b2",
                  display: "inline-block",
                  animation: "pulse 2s infinite",
                }}
              />
              <span
                style={{
                  fontSize: "clamp(9px, 1vw, 12px)",
                  color: "#0891b2",
                  fontWeight: 600,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  fontFamily: "monospace",
                }}
              >
                Live Node Active
              </span>
            </div>
          </div>
        </div>

        {/* Warning Banner */}
        <div
          style={{
            marginBottom: 24,
            background: "rgba(245,158,11,0.06)",
            border: "1px solid rgba(245,158,11,0.2)",
            borderRadius: 10,
            padding: "9px 18px",
            textAlign: "center",
          }}
        >
          <p
            style={{
              fontSize: "clamp(10px, 1vw, 12px)",
              color: "#b45309",
              fontFamily: "monospace",
              letterSpacing: 1,
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            ⚠ ArcFlare Ecosystem Monitoring Node — Running on{" "}
            <span style={{ textDecoration: "underline", fontWeight: 700 }}>Arc Testnet Mode</span>.
            Connected to Live Cloud Ledger.
          </p>
        </div>

        {/* METRIC CARDS */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)",
            gap: 16,
            marginBottom: 24,
          }}
        >
          {[
            {
              label: "Total Volume",
              value: metrics.totalVolume.toFixed(2),
              unit: "USDC",
              change: "+18%",
              iconBg: "#dcfce7",
              iconColor: "#16a34a",
              icon: "$",
              dataKey: "volume",
              stroke: "#0891b2",
            },
            {
              label: "Transactions",
              value: metrics.totalTransactions.toString(),
              unit: "",
              change: "+12%",
              iconBg: "#ede9fe",
              iconColor: "#7c3aed",
              icon: "↔",
              dataKey: "count",
              stroke: "#8b5cf6",
            },
            {
              label: "Success Rate",
              value: `${metrics.successRate.toFixed(1)}%`,
              unit: "",
              change: "+3%",
              iconBg: "#fef9c3",
              iconColor: "#ca8a04",
              icon: "✓",
              dataKey: "volume",
              stroke: "#f59e0b",
            },
            {
              label: "Avg Tx Value",
              value: `$${avgTxValue.toFixed(2)}`,
              unit: "USDC",
              change: "+11%",
              iconBg: "#dbeafe",
              iconColor: "#2563eb",
              icon: "↗",
              dataKey: "volume",
              stroke: "#3b82f6",
            },
          ].map((card, i) => (
            <div
              key={i}
              style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: "20px",
                boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    background: card.iconBg,
                    borderRadius: 9,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 15,
                    color: card.iconColor,
                  }}
                >
                  {card.icon}
                </div>
                <span
                  style={{
                    fontSize: 11,
                    color: "#16a34a",
                    fontWeight: 600,
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: 20,
                    padding: "2px 8px",
                  }}
                >
                  {card.change}
                </span>
              </div>
              <p
                style={{
                  fontSize: 10,
                  color: "#94a3b8",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  margin: "0 0 4px 0",
                }}
              >
                {card.label}
              </p>
              <p
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: "#0f172a",
                  fontFamily: "monospace",
                  margin: "0 0 2px 0",
                }}
              >
                {card.value}{" "}
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 400 }}>{card.unit}</span>
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
                      <Area
                        type="monotone"
                        dataKey={card.dataKey}
                        stroke={card.stroke}
                        strokeWidth={1.5}
                        fill={`url(#cg${i})`}
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* CHART + GATEWAY OVERVIEW */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 300px",
            gap: 20,
            marginBottom: 24,
          }}
        >
          {/* Analytics Chart */}
          <div
            style={{
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 16,
              padding: 24,
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 4,
              }}
            >
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#0f172a", margin: 0 }}>
                  Payment Analytics
                </h3>
                <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 3, marginBottom: 0 }}>
                  Stablecoin transaction activity
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  style={{
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    padding: "5px 12px",
                    fontSize: 12,
                    color: "#64748b",
                    cursor: "pointer",
                  }}
                >
                  Last 7 Days ▾
                </button>
                <button
                  style={{
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    padding: "5px 12px",
                    fontSize: 12,
                    color: "#64748b",
                    cursor: "pointer",
                  }}
                >
                  ↓ Export
                </button>
                <button
                  style={{
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    padding: "5px 10px",
                    fontSize: 12,
                    color: "#64748b",
                    cursor: "pointer",
                  }}
                >
                  ···
                </button>
              </div>
            </div>
            <div style={{ height: 190, marginTop: 20 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0891b2" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0891b2" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#fff",
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      fontSize: 12,
                      boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                    }}
                    labelStyle={{ color: "#64748b" }}
                    itemStyle={{ color: "#0891b2" }}
                    formatter={(val: any) => [`${val} USDC`, "Volume"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="volume"
                    stroke="#0891b2"
                    strokeWidth={2.5}
                    fill="url(#mainGrad)"
                    dot={{ fill: "#0891b2", r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 6, fill: "#0891b2" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Sub metrics */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)",
                gap: 10,
                marginTop: 18,
                paddingTop: 18,
                borderTop: "1px solid #f1f5f9",
              }}
            >
              {[
                {
                  label: "Successful Payments",
                  value: successCount,
                  color: "#0891b2",
                  bg: "#ecfeff",
                  border: "#a5f3fc",
                  icon: "✓",
                },
                {
                  label: "Failed Payments",
                  value: failedCount,
                  color: "#dc2626",
                  bg: "#fef2f2",
                  border: "#fecaca",
                  icon: "✗",
                },
                {
                  label: "Success Rate",
                  value: `${metrics.successRate.toFixed(1)}%`,
                  color: "#2563eb",
                  bg: "#eff6ff",
                  border: "#bfdbfe",
                  icon: "◎",
                },
                {
                  label: "Avg Txn Value",
                  value: `$${avgTxValue.toFixed(2)}`,
                  color: "#d97706",
                  bg: "#fffbeb",
                  border: "#fde68a",
                  icon: "↗",
                },
              ].map((m, i) => (
                <div
                  key={i}
                  style={{
                    background: m.bg,
                    border: `1px solid ${m.border}`,
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
                    <span style={{ color: m.color, fontSize: 11 }}>{m.icon}</span>
                    <p
                      style={{
                        fontSize: 9,
                        color: "#64748b",
                        textTransform: "uppercase",
                        letterSpacing: 0.3,
                        margin: 0,
                      }}
                    >
                      {m.label}
                    </p>
                  </div>
                  <p
                    style={{
                      fontSize: 17,
                      fontWeight: 700,
                      color: m.color,
                      fontFamily: "monospace",
                      margin: 0,
                    }}
                  >
                    {m.value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Gateway Overview */}
          <div
            style={{
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 16,
              padding: 24,
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#0f172a", margin: 0 }}>
                Gateway Overview
              </h3>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: 20,
                  padding: "3px 10px",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#16a34a",
                    display: "inline-block",
                  }}
                />
                <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 600 }}>Live</span>
              </div>
            </div>

            <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 4px 0" }}>
              Total Revenue (USDC)
            </p>
            <p
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: "#0f172a",
                fontFamily: "monospace",
                margin: "0 0 2px 0",
              }}
            >
              {metrics.totalVolume.toFixed(2)}{" "}
              <span style={{ fontSize: 14, color: "#0891b2" }}>USDC</span>
            </p>
            <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 20px 0" }}>
              ≈ ${metrics.totalVolume.toFixed(2)}
            </p>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Successful Payments</p>
                <p style={{ fontSize: 12, color: "#0f172a", fontWeight: 600, margin: 0 }}>
                  {metrics.successRate.toFixed(1)}%
                </p>
              </div>
              <p
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#0f172a",
                  fontFamily: "monospace",
                  margin: "0 0 8px 0",
                }}
              >
                {successCount}
              </p>
              <div
                style={{ height: 5, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${metrics.successRate}%`,
                    background: "linear-gradient(90deg,#0891b2,#22d3ee)",
                    borderRadius: 3,
                    transition: "width 1s ease",
                  }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Failed Payments</p>
                <p style={{ fontSize: 12, color: "#0f172a", fontWeight: 600, margin: 0 }}>
                  {(100 - metrics.successRate).toFixed(1)}%
                </p>
              </div>
              <p
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#0f172a",
                  fontFamily: "monospace",
                  margin: "0 0 8px 0",
                }}
              >
                {failedCount}
              </p>
              <div
                style={{ height: 5, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${100 - metrics.successRate}%`,
                    background: "#dc2626",
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>

            {/* Agent Pipeline */}
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: 14,
                marginBottom: 14,
              }}
            >
              <p
                style={{
                  fontSize: 10,
                  color: "#94a3b8",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  margin: "0 0 2px 0",
                }}
              >
                ERC-8004 Agent Pipeline
              </p>
              <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 10px 0" }}>
                Programmatically instantiate sandboxed SCA nodes
              </p>
              <button
                onClick={triggerAgentLifecycle}
                disabled={isDeploying}
                style={{
                  width: "100%",
                  padding: "9px 0",
                  borderRadius: 8,
                  background: isDeploying ? "#f1f5f9" : "rgba(8,145,178,0.08)",
                  border: `1px solid ${isDeploying ? "#e2e8f0" : "rgba(8,145,178,0.3)"}`,
                  color: isDeploying ? "#94a3b8" : "#0891b2",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: isDeploying ? "not-allowed" : "pointer",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  fontFamily: "monospace",
                }}
              >
                {isDeploying ? "COMPILING..." : "⚡ LAUNCH AGENT LIFECYCLE"}
              </button>
              {deploymentError && (
                <p style={{ color: "#dc2626", fontSize: 10, marginTop: 6, margin: "6px 0 0 0" }}>
                  ❌ {deploymentError}
                </p>
              )}
              {deployedAgent && (
                <p style={{ color: "#0891b2", fontSize: 10, marginTop: 6, margin: "6px 0 0 0" }}>
                  ● Live Agent Registry Bound: #{deployedAgent.agentId}
                </p>
              )}
            </div>

            <button
              onClick={() => {
                navigator.clipboard.writeText(INTERNAL_API_KEY);
                alert("API Key copied!");
              }}
              style={{
                width: "100%",
                padding: "12px 0",
                fontSize: 13,
                background: "#0891b2",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                cursor: "pointer",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              🔑 Generate API Key →
            </button>
          </div>
        </div>

        {/* SETTLEMENT STREAMS TABLE */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-4 md:p-6 shadow-2xl overflow-hidden">
          <div className="flex flex-wrap items-center justify-between mb-6 gap-2">
            <h3 className="text-sm md:text-base font-bold tracking-wide uppercase font-mono text-white">
              Inbound Agent Settlement Streams
            </h3>
            <span className="text-[10px] text-gray-500 font-mono bg-[#120b08] px-3 py-1 rounded-lg border border-[#3a2a20]">
              Prisma Database Sync
            </span>
          </div>

          {error && <div className="text-red-400 text-xs font-mono mb-4">❌ {error}</div>}

          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono min-w-[600px]">
              <thead>
                <tr className="text-gray-500 uppercase tracking-wider border-b border-[#3a2a20]">
                  <th className="text-left pb-3 pr-3">Reference</th>
                  <th className="text-left pb-3 pr-3">Entity</th>
                  <th className="text-left pb-3 pr-3">Chain</th>
                  <th className="text-left pb-3 pr-3">Amount</th>
                  <th className="text-left pb-3 pr-3">Status</th>
                  <th className="text-left pb-3">Attestation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#3a2a20]/40">
                {payments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-12 text-gray-500 text-sm font-mono">
                      No settlement streams recorded yet.
                    </td>
                  </tr>
                ) : (
                  payments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-[#120b08]/40 transition-colors">
                      <td className="py-3 pr-3">
                        <div className="text-cyan-400 text-xs">{payment.reference.slice(0, 12)}...</div>
                        <div className="text-gray-500 text-[9px] mt-0.5">
                          {new Date(payment.paid_at).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="text-gray-300 text-xs">{payment.sender_email.slice(0, 10)}...</div>
                      </td>
                      <td className="py-3 pr-3">
                        <span className="text-cyan-400 text-[10px]">{payment.chain}</span>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="text-white font-bold text-xs">{payment.amount.toFixed(2)}</div>
                        <div className="text-amber-400 text-[9px]">{payment.currency}</div>
                      </td>
                      <td className="py-3 pr-3">
                        <span className={`px-2 py-1 rounded text-[9px] font-bold border ${
                          payment.status === "SUCCESS"
                            ? "bg-green-500/10 text-green-400 border-green-500/20"
                            : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                        }`}>
                          {payment.status}
                        </span>
                      </td>
                      <td className="py-3">
                        <div className="text-[9px] text-green-400">{payment.cctp_telemetry.attestation_status}</div>
                        <div className="text-gray-600 text-[8px] mt-0.5">Nonce: {payment.cctp_telemetry.nonce}</div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}