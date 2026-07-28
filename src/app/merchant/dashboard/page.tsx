// src/app/merchant/dashboard/page.tsx
"use client";

import Image from "next/image";
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

interface MerchantInfo {
  businessName: string;
  email: string;
  apiKeyHint: string;
  walletType?: 'CIRCLE' | 'EXTERNAL';
  walletAddress?: string | null;
}

export default function MerchantDashboard() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [merchant, setMerchant] = useState<MerchantInfo | null>(null);

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

  // Payment link creation state — restored from the original merchant dashboard
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [newLink, setNewLink] = useState<any>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Responsive state ──
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  // ── Withdrawal state ──
  const [withdrawAddress, setWithdrawAddress] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<any>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // ── Auth gate — this is the whole point of the merge. No merchant
  // session, no dashboard. Redirect to login rather than showing anyone's
  // data. ──
  useEffect(() => {
    fetch("/api/merchant/me")
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) {
          router.replace("/merchant/login");
          return;
        }
        setMerchant({
          businessName: data.merchant.businessName,
          email: data.merchant.email,
          apiKeyHint: data.merchant.apiKeyHint,
          walletType: data.merchant.walletType,
          walletAddress: data.merchant.walletAddress,
        });
      })
      .catch(() => router.replace("/merchant/login"))
      .finally(() => setCheckingAuth(false));
  }, [router]);

  // ── Data fetching — scoped server-side to the logged-in merchant via
  // the merchant_token cookie. No API key needed in the browser at all. ──
  const fetchLiveDatabaseState = async (isSilentUpdate = false) => {
    try {
      const res = await fetch("/api/payments/all");
      if (res.status === 401) {
        router.replace("/merchant/login");
        return;
      }
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
        throw new Error(json.error || "Could not load dashboard data.");
      }
    } catch (err: any) {
      if (!isSilentUpdate) setError("Failed to load your dashboard data. Try refreshing.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setLinkError('Enter a valid amount.');
      return;
    }
    setCreating(true);
    setLinkError(null);
    setNewLink(null);

    try {
      const res = await fetch('/api/merchant/payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          currency: 'USDC',
          description,
          webhookUrl: webhookUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setNewLink(data);
      setAmount('');
      setDescription('');
      setWebhookUrl('');
    } catch (err: any) {
      setLinkError(err.message || 'Could not create payment link.');
    } finally {
      setCreating(false);
    }
  };

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawing(true);
    setWithdrawError(null);
    setWithdrawResult(null);

    try {
      const res = await fetch('/api/merchant/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          destinationAddress: withdrawAddress,
          amount: withdrawAmount,
        }),
      });

      const data = await res.json();

      if (!data.success) throw new Error(data.error);

      setWithdrawResult(data);
      setWithdrawAddress('');
      setWithdrawAmount('');
    } catch (err: any) {
      setWithdrawError(err.message || 'Withdrawal failed.');
    } finally {
      setWithdrawing(false);
    }
  };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei",
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Agent deployment failed.");
      setDeployedAgent(data);
    } catch (err: any) {
      setDeploymentError(err.message || "Failed to deploy agent.");
    } finally {
      setIsDeploying(false);
    }
  };

  useEffect(() => {
    if (checkingAuth || !merchant) return;
    fetchLiveDatabaseState();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchLiveDatabaseState(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [checkingAuth, merchant]);

  const successCount = payments.filter((p) => p.status === "SUCCESS").length;
  const failedCount = payments.filter((p) => p.status !== "SUCCESS").length;
  const avgTxValue = payments.length > 0 ? metrics.totalVolume / payments.length : 0;

  if (checkingAuth || loading) {
    return (
      <div
        className="light"
        style={{
          minHeight: "100vh",
          background: "var(--background)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p
          style={{
            color: "var(--primary)",
            fontFamily: "monospace",
            fontSize: 13,
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          Loading your dashboard...
        </p>
      </div>
    );
  }

  if (!merchant) return null; // mid-redirect to login

  return (
    <div
      className="light"
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "var(--background)",
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <Image
            src="/arcflare-logo.png.png"
            alt="FlareHQ"
            width={36}
            height={36}
            style={{ borderRadius: 8, objectFit: "contain" }}
          />
          <div>
            <p style={{ color: "var(--surface)", fontSize: 14, fontWeight: 700, lineHeight: 1, margin: 0 }}>FlareHQ</p>
            <p style={{ color: "var(--text-secondary)", fontSize: 10, margin: "3px 0 0 0" }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
          {[
            {
              group: "CORE",
              items: [
                { label: "Dashboard", href: "/merchant/dashboard", active: true, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg> },
                { label: "Homepage", href: "/", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg> },
                { label: "Transactions", href: "/transactions", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg> },
                { label: "Checkout", href: "/merchant/dashboard#checkout", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></svg> },
                { label: "Escrow", href: "/escrow", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg> },
              ]
            },
            {
              group: "AGENTS & COMMERCE",
              items: [
                { label: "Agents", href: "/agents", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /><line x1="12" y1="11" x2="12" y2="15" /></svg> },
                { label: "AI Agent", href: "/agent-services", active: false, icon: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" /></svg> },
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
              ]
            },
          ].map((section) => (
            <div key={section.group} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1, padding: "6px 12px 2px", margin: 0 }}>
                {section.group}
              </p>
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
                    color: item.active ? "#22d3ee" : "var(--text-secondary)",
                    border: item.active ? "1px solid rgba(34,211,238,0.25)" : "1px solid transparent",
                  }}
                  onMouseEnter={e => { if (!item.active) { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.04)"; (e.currentTarget as HTMLAnchorElement).style.color = "#d1d5db"; } }}
                  onMouseLeave={e => { if (!item.active) { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; (e.currentTarget as HTMLAnchorElement).style.color = "var(--text-secondary)"; } }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>

        {/* Merchant identity + sign out */}
        <div
          style={{
            background: "rgba(34,211,238,0.1)",
            border: "1px solid rgba(34,211,238,0.2)",
            borderRadius: 12,
            padding: "14px 14px",
            marginTop: 16,
          }}
        >
          <p style={{ color: "var(--text-secondary)", fontSize: 9, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 6px 0" }}>
            Signed in as
          </p>
          <p style={{ color: "var(--surface)", fontSize: 13, fontWeight: 700, margin: "0 0 2px 0" }}>
            {merchant.businessName}
          </p>
          <p style={{ color: "var(--text-secondary)", fontSize: 10, margin: "0 0 10px 0" }}>{merchant.email}</p>
          <button
            onClick={() => router.push("/merchant/settings")}
            style={{
              width: "100%",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              padding: "7px 0",
              fontSize: 11,
              color: "var(--text-secondary)",
              cursor: "pointer",
              marginBottom: 6,
            }}
          >
            ⚙ Payout Settings
          </button>
          <button
            onClick={async () => {
              await fetch("/api/merchant/me", { method: "DELETE" });
              router.replace("/merchant/login");
            }}
            style={{
              width: "100%",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              padding: "7px 0",
              fontSize: 11,
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>

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
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
            <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>
              Arc Testnet Mode
            </span>
          </div>
        </div>
      </aside>

      {isMobile && sidebarOpen && (
        <div
          style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 999 }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── MAIN CONTENT ── */}
      <main style={{ flex: 1, padding: isMobile ? "16px" : "32px", overflowX: "hidden", background: "var(--background)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {isMobile && (
              <button
                onClick={() => setSidebarOpen(true)}
                style={{ background: "transparent", border: "none", fontSize: 24, color: "var(--text)", cursor: "pointer", padding: 0 }}
              >
                ☰
              </button>
            )}
            <div>
              <h1 style={{ fontSize: "clamp(20px, 4vw, 28px)", fontWeight: 700, color: "var(--text)", margin: "0 0 4px 0" }}>
                Welcome back, {merchant.businessName} 👋
              </h1>
              <p style={{ color: "var(--text-secondary)", fontSize: "clamp(12px, 1.5vw, 16px)", margin: 0 }}>
                Here's what's happening with your business today.
              </p>
            </div>
          </div>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "rgba(8,145,178,0.08)", border: "1px solid rgba(8,145,178,0.2)",
              borderRadius: 10, padding: "7px 14px",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--primary)", display: "inline-block" }} />
            <span style={{ fontSize: "clamp(9px, 1vw, 12px)", color: "var(--primary)", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace" }}>
              Live
            </span>
          </div>
        </div>

        {/* METRIC CARDS */}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          {[
            { label: "Total Volume", value: metrics.totalVolume.toFixed(2), unit: "USDC", iconBg: "#dcfce7", iconColor: "#16a34a", icon: "$", stroke: "var(--primary)" },
            { label: "Transactions", value: metrics.totalTransactions.toString(), unit: "", iconBg: "#ede9fe", iconColor: "#7c3aed", icon: "↔", stroke: "#8b5cf6" },
            { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, unit: "", iconBg: "#fef9c3", iconColor: "#ca8a04", icon: "✓", stroke: "#f59e0b" },
            { label: "Avg Tx Value", value: `$${avgTxValue.toFixed(2)}`, unit: "USDC", iconBg: "#dbeafe", iconColor: "#2563eb", icon: "↗", stroke: "#3b82f6" },
          ].map((card, i) => (
            <div key={i} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "20px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              <div style={{ width: 36, height: 36, background: card.iconBg, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: card.iconColor, marginBottom: 12 }}>
                {card.icon}
              </div>
              <p style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 4px 0" }}>{card.label}</p>
              <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: "monospace", margin: "0 0 2px 0" }}>
                {card.value} <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 400 }}>{card.unit}</span>
              </p>
            </div>
          ))}
        </div>

        {/* CREATE PAYMENT LINK */}
        <div id="checkout" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, marginBottom: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>Create Payment Link</h3>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 20px 0" }}>Generate a checkout link customers can pay directly from their own wallet.</p>

          <form onSubmit={handleCreateLink} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 14, alignItems: "end" }}>
            <div>
              <label style={{ display: "block", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Amount (USDC)
              </label>
              <input
                type="number" step="0.01" min="0.01" placeholder="e.g. 10.00"
                value={amount} onChange={(e) => setAmount(e.target.value)} required
                style={{ width: "100%", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Description (optional)
              </label>
              <input
                type="text" placeholder="e.g. License fee"
                value={description} onChange={(e) => setDescription(e.target.value)}
                style={{ width: "100%", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Webhook URL (optional)
              </label>
              <input
                type="url" placeholder="https://your-site.com/webhook"
                value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
                style={{ width: "100%", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div style={{ gridColumn: isMobile ? "1" : "1 / -1" }}>
              {linkError && <p style={{ color: "var(--danger)", fontSize: 12, margin: "0 0 10px 0" }}>❌ {linkError}</p>}
              <button
                type="submit" disabled={creating}
                style={{
                  padding: "11px 24px", background: creating ? "var(--text-secondary)" : "var(--primary)", color: "var(--surface)",
                  border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700,
                  cursor: creating ? "not-allowed" : "pointer",
                }}
              >
                {creating ? "Generating..." : "Generate Payment Link →"}
              </button>
            </div>
          </form>

          {newLink && (
            <div style={{ marginTop: 18, background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 12, padding: 16 }}>
              <p style={{ color: "var(--primary)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 10px 0" }}>
                ✓ Link Created
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <p style={{ color: "var(--text)", fontSize: 12, fontFamily: "monospace", margin: 0, flex: 1, wordBreak: "break-all" }}>
                  {newLink.checkoutUrl}
                </p>
                <button
                  onClick={() => copyLink(newLink.checkoutUrl)}
                  style={{
                    flexShrink: 0, background: copied ? "var(--primary)" : "var(--surface)", border: "1px solid var(--primary)",
                    borderRadius: 8, padding: "6px 12px", color: copied ? "var(--surface)" : "var(--primary)",
                    fontSize: 11, cursor: "pointer", fontWeight: 700,
                  }}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <p style={{ color: "var(--text-secondary)", fontSize: 11, margin: "8px 0 0 0" }}>
                Amount: {newLink.amount} USDC • Ref: {newLink.reference}
              </p>
            </div>
          )}
        </div>
        {merchant.walletType === 'CIRCLE' && (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, marginBottom: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>Withdraw Funds</h3>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 20px 0" }}>
              Move USDC from your FlareHQ payout wallet ({merchant.walletAddress?.slice(0, 10)}...) to any address you control.
            </p>

            <form onSubmit={handleWithdraw} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr auto", gap: 14, alignItems: "end" }}>
              <div>
                <label style={{ display: "block", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                  Destination Address
                </label>
                <input
                  type="text" placeholder="0x..."
                  value={withdrawAddress} onChange={(e) => setWithdrawAddress(e.target.value)} required
                  style={{ width: "100%", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text)", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
                />
              </div>
              <div>
                <label style={{ display: "block", color: "var(--text-secondary)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                  Amount (USDC)
                </label>
                <input
                  type="number" step="0.01" min="0.01" placeholder="e.g. 50.00"
                  value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} required
                  style={{ width: "100%", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text)", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              <button
                type="submit" disabled={withdrawing}
                style={{
                  padding: "11px 24px", background: withdrawing ? "var(--text-secondary)" : "var(--primary)", color: "var(--surface)",
                  border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700,
                  cursor: withdrawing ? "not-allowed" : "pointer", whiteSpace: "nowrap",
                }}
              >
                {withdrawing ? "Sending..." : "Withdraw →"}
              </button>
            </form>

            {withdrawError && <p style={{ color: "var(--danger)", fontSize: 12, margin: "12px 0 0 0" }}>❌ {withdrawError}</p>}

            {withdrawResult && (
              <div style={{ marginTop: 18, background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 12, padding: 16 }}>
                <p style={{ color: "var(--primary)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 8px 0" }}>
                  ✓ Withdrawal Sent
                </p>
                <p style={{ color: "var(--text)", fontSize: 12, margin: "0 0 4px 0" }}>
                  {withdrawResult.amount} USDC → {withdrawResult.to.slice(0, 10)}...
                </p>
                <a href={withdrawResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)", fontSize: 11, fontFamily: "monospace" }}>
                  View transaction ↗
                </a>
              </div>
            )}
          </div>
        )}
        {/* CHART + OVERVIEW */}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 300px", gap: 20, marginBottom: 24 }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", margin: 0 }}>Payment Analytics</h3>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3, marginBottom: 0 }}>Your stablecoin transaction activity</p>
            <div style={{ height: 190, marginTop: 20 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mainGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-secondary)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "var(--text-secondary)", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
                    labelStyle={{ color: "var(--text-secondary)" }}
                    itemStyle={{ color: "var(--primary)" }}
                    formatter={(val: any) => [`${val} USDC`, "Volume"]}
                  />
                  <Area type="monotone" dataKey="volume" stroke="var(--primary)" strokeWidth={2.5} fill="url(#mainGrad)" dot={{ fill: "var(--primary)", r: 4, strokeWidth: 0 }} activeDot={{ r: 6, fill: "var(--primary)" }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 10, marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--surface-secondary)" }}>
              {[
                { label: "Successful", value: successCount, color: "var(--primary)", bg: "#ecfeff", border: "#a5f3fc", icon: "✓" },
                { label: "Failed", value: failedCount, color: "var(--danger)", bg: "#fef2f2", border: "#fecaca", icon: "✗" },
                { label: "Success Rate", value: `${metrics.successRate.toFixed(1)}%`, color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe", icon: "◎" },
                { label: "Avg Txn Value", value: `$${avgTxValue.toFixed(2)}`, color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "↗" },
              ].map((m, i) => (
                <div key={i} style={{ background: m.bg, border: `1px solid ${m.border}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
                    <span style={{ color: m.color, fontSize: 11 }}>{m.icon}</span>
                    <p style={{ fontSize: 9, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.3, margin: 0 }}>{m.label}</p>
                  </div>
                  <p style={{ fontSize: 17, fontWeight: 700, color: m.color, fontFamily: "monospace", margin: 0 }}>{m.value}</p>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.05)", display: "flex", flexDirection: "column" }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", margin: "0 0 20px 0" }}>Your API Key</h3>
            <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "0 0 4px 0" }}>Key hint (full key shown at signup only)</p>
            <p style={{ fontSize: 13, fontFamily: "monospace", color: "var(--text)", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", margin: "0 0 20px 0", wordBreak: "break-all" }}>
              {merchant.apiKeyHint}
            </p>

            <div style={{ background: "var(--background)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <p style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1, margin: "0 0 2px 0" }}>
                ERC-8004 Agent Pipeline
              </p>
              <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "0 0 10px 0" }}>
                Deploy an agent identity under your account
              </p>
              <button
                onClick={triggerAgentLifecycle}
                disabled={isDeploying}
                style={{
                  width: "100%", padding: "9px 0", borderRadius: 8,
                  background: isDeploying ? "var(--surface-secondary)" : "rgba(8,145,178,0.08)",
                  border: `1px solid ${isDeploying ? "var(--border)" : "rgba(8,145,178,0.3)"}`,
                  color: isDeploying ? "var(--text-secondary)" : "var(--primary)",
                  fontSize: 11, fontWeight: 700, cursor: isDeploying ? "not-allowed" : "pointer",
                  letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace",
                }}
              >
                {isDeploying ? "DEPLOYING..." : "⚡ DEPLOY AGENT"}
              </button>
              {deploymentError && <p style={{ color: "var(--danger)", fontSize: 10, margin: "6px 0 0 0" }}>❌ {deploymentError}</p>}
              {deployedAgent && <p style={{ color: "var(--primary)", fontSize: 10, margin: "6px 0 0 0" }}>● Agent deployed: {deployedAgent.agent?.name}</p>}
            </div>

            <a
              href="/docs/api"
              style={{
                width: "100%", padding: "12px 0", fontSize: 13, background: "var(--primary)", color: "var(--surface)",
                border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 600,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8, textDecoration: "none",
              }}
            >
              📖 View API Docs →
            </a>
          </div>
        </div>

        {/* TRANSACTIONS TABLE */}
        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-4 md:p-6 shadow-2xl overflow-hidden">
          <div className="flex flex-wrap items-center justify-between mb-6 gap-2">
            <h3 className="text-sm md:text-base font-bold tracking-wide uppercase font-mono text-white">
              Your Recent Payments
            </h3>
          </div>

          {error && <div className="text-red-400 text-xs font-mono mb-4">❌ {error}</div>}

          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono min-w-[600px]">
              <thead>
                <tr className="text-gray-500 uppercase tracking-wider border-b border-[#3a2a20]">
                  <th className="text-left pb-3 pr-3">Reference</th>
                  <th className="text-left pb-3 pr-3">Sender</th>
                  <th className="text-left pb-3 pr-3">Chain</th>
                  <th className="text-left pb-3 pr-3">Amount</th>
                  <th className="text-left pb-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#3a2a20]/40">
                {payments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-12 text-gray-500 text-sm font-mono">
                      No payments yet. Create a payment link to get started.
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
                      <td className="py-3">
                        <span className={`px-2 py-1 rounded text-[9px] font-bold border ${payment.status === "SUCCESS"
                          ? "bg-green-500/10 text-green-400 border-green-500/20"
                          : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          }`}>
                          {payment.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
