"use client";

import Image from "next/image";   // ✅ add this import
import React, { useState, useEffect } from "react";

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";
const API_BASE = "https://arcflare-gateway.onrender.com";

const NAV = [
  { group: "CORE", items: [
    { label: "Dashboard",    href: "/dashboard" },
    { label: "Homepage",     href: "/" },
    { label: "Transactions", href: "/transactions" },
    { label: "Checkout",     href: "/checkout" },
    { label: "Escrow",       href: "/escrow" },
  ]},
  { group: "AGENTS & COMMERCE", items: [
    { label: "Agents",         href: "/agents" },
    { label: "AI Agent",       href: "/agent-service", active: true },
    { label: "Agent Wallets",  href: "/agent-wallets" },
    { label: "Jobs",           href: "/jobs" },
    { label: "Nanopayments",   href: "/nano" },
  ]},
  { group: "BUSINESS", items: [
    { label: "Payroll",         href: "/payroll" },
    { label: "Scheduled",       href: "/scheduled" },
    { label: "Consumer (Flow)", href: "/consumer" },
  ]},
  { group: null, items: [
    { label: "Support", href: "/support" },
  ]},
];

interface AgentInfo {
  agentId: string;
  ownerAddress: string;
  reputationScore: number | null;
  pricing: { perRequest: string };
  availableTasks: string[];
}

// ── Static styles ─────────────────────────────────────────────────────────
const styles = {
  page: {
    display: "flex",
    minHeight: "100vh",
    background: "#0e0b08",
    color: "#f0ece6",
    fontFamily: "Inter, system-ui, sans-serif",
  } as React.CSSProperties,
  aside: {
    width: 220,
    background: "#1a1410",
    display: "flex",
    flexDirection: "column" as const,
    padding: "24px 14px",
    flexShrink: 0,
    position: "sticky" as const,
    top: 0,
    height: "100vh",
    overflowY: "auto" as const,
    borderRight: "1px solid #2d2015",
  } as React.CSSProperties,
  main: {
    flex: 1,
    padding: "32px",
    overflowX: "hidden" as const,
  } as React.CSSProperties,
  card: {
    background: "#1a1410",
    border: "1px solid #2d2015",
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
  } as React.CSSProperties,
  input: {
    width: "100%",
    padding: "12px 14px",
    background: "#251c12",
    border: "1px solid #3d2e1a",
    borderRadius: 10,
    color: "#f0ece6",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
  } as React.CSSProperties,
  label: {
    fontSize: 11,
    color: "#6b5a45",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 6,
    display: "block" as const,
  } as React.CSSProperties,
};

// ── Dynamic style functions ──────────────────────────────────────────────
const btnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: "12px 24px",
  background: disabled ? "rgba(200,151,90,0.3)" : "#c8975a",
  color: disabled ? "#6b5a45" : "#0e0b08",
  border: "none",
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 14,
  cursor: disabled ? "not-allowed" : "pointer",
});

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "8px 18px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${active ? "#c8975a" : "#2d2015"}`,
  background: active ? "rgba(200,151,90,0.1)" : "transparent",
  color: active ? "#c8975a" : "#6b5a45",
  fontWeight: active ? 700 : 400,
});

const badgeStyle = (color: string): React.CSSProperties => ({
  fontSize: 10,
  padding: "3px 10px",
  borderRadius: 12,
  background: `${color}15`,
  color,
  border: `1px solid ${color}40`,
  fontWeight: 700,
});

export default function AgentServicePage() {
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [task, setTask] = useState("");
  const [context, setContext] = useState("");
  const [eoaAddress, setEoaAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"call" | "info">("info");

  useEffect(() => {
    fetch(`${API_BASE}/api/agent/service`)
      .then((r) => r.json())
      .then(setAgentInfo)
      .catch(() => {});
  }, []);

  const callAgent = async () => {
    if (!task.trim() || !eoaAddress.trim()) {
      setError("Task and EOA wallet address are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`${API_BASE}/api/x402/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          resourceUrl: `${API_BASE}/api/agent/service`,
          eoaAddress,
          body: JSON.stringify({ task, context }),
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Agent call failed");
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      {/* Sidebar */}
      <aside style={styles.aside}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
          {/* ─── Logo replaced with Image ─── */}
          <Image
            src="/arcflare-logo.png"
            alt="ArcFlare"
            width={36}
            height={36}
            style={{ borderRadius: 8, objectFit: "contain" }}
          />
          <div>
            <p style={{ color: "#f0ece6", fontSize: 14, fontWeight: 700, margin: 0 }}>ArcFlare</p>
            <p style={{ color: "#6b5a45", fontSize: 9, margin: 0 }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          {NAV.map((section) => (
            <div key={section.group || "other"} style={{ marginBottom: 8 }}>
              {section.group && <p style={{ fontSize: 9, color: "#4b3d2c", textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "4px 10px", margin: 0 }}>{section.group}</p>}
              {section.items.map((item) => (
                <a key={item.label} href={item.href} style={{ display: "block", padding: "8px 10px", borderRadius: 8, textDecoration: "none", fontSize: 13, color: (item as any).active ? "#c8975a" : "#6b5a45", background: (item as any).active ? "rgba(200,151,90,0.12)" : "transparent", fontWeight: (item as any).active ? 600 : 400 }}>
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "8px 12px", marginTop: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block", marginRight: 6 }} />
          <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" as const }}>Arc Testnet</span>
        </div>
      </aside>

      {/* Main (unchanged) */}
      <main style={styles.main}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>ArcFlare AI Agent</h1>
            <span style={badgeStyle("#10b981")}>ERC-8004</span>
            <span style={badgeStyle("#c8975a")}>x402 Paid</span>
          </div>
          <p style={{ color: "#6b5a45", fontSize: 13, margin: 0 }}>
            An autonomous AI agent with onchain identity — pays get settled via Circle Gateway Nanopayments
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          <button style={tabStyle(activeTab === "info")} onClick={() => setActiveTab("info")}>🤖 Agent Info</button>
          <button style={tabStyle(activeTab === "call")} onClick={() => setActiveTab("call")}>⚡ Call Agent</button>
        </div>

        {/* Agent Info Tab */}
        {activeTab === "info" && (
          <div style={styles.card}>
            {agentInfo ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
                  {[
                    { label: "Agent ID (ERC-8004)", value: agentInfo.agentId },
                    { label: "Owner Address", value: agentInfo.ownerAddress },
                    { label: "Reputation Score", value: agentInfo.reputationScore !== null ? `${agentInfo.reputationScore}/100` : "Not yet recorded" },
                    { label: "Price per Request", value: agentInfo.pricing?.perRequest || "$0.001 USDC" },
                  ].map((row) => (
                    <div key={row.label} style={{ background: "#251c12", borderRadius: 12, padding: 16 }}>
                      <p style={{ fontSize: 10, color: "#6b5a45", textTransform: "uppercase" as const, letterSpacing: 1, margin: "0 0 6px" }}>{row.label}</p>
                      <p style={{ fontSize: 13, color: "#c8975a", fontFamily: "monospace", margin: 0, wordBreak: "break-all" as const }}>{row.value}</p>
                    </div>
                  ))}
                </div>
                <div>
                  <p style={styles.label}>Available Tasks</p>
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
                    {(agentInfo.availableTasks || []).map((t: string) => (
                      <span key={t} style={{ fontSize: 12, padding: "6px 12px", borderRadius: 20, background: "rgba(200,151,90,0.08)", border: "1px solid rgba(200,151,90,0.2)", color: "#c8975a", cursor: "pointer" }}
                        onClick={() => { setTask(t); setActiveTab("call"); }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <p style={{ color: "#6b5a45", fontSize: 13 }}>Loading agent info...</p>
            )}
          </div>
        )}

        {/* Call Agent Tab */}
        {activeTab === "call" && (
          <div style={styles.card}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 20px" }}>Call the AI Agent</h3>
            <p style={{ color: "#6b5a45", fontSize: 12, margin: "0 0 20px" }}>
              This costs $0.001 USDC per call, paid via x402 from your EOA Gateway balance.
            </p>

            <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
              <div>
                <span style={styles.label}>Your EOA Wallet Address (needs Gateway balance)</span>
                <input style={styles.input} value={eoaAddress} onChange={(e) => setEoaAddress(e.target.value)} placeholder="0x..." />
              </div>
              <div>
                <span style={styles.label}>Task</span>
                <textarea style={{ ...styles.input, height: 80, resize: "vertical" as const }} value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Analyze the best payment strategy for a small freelance business using ArcFlare" />
              </div>
              <div>
                <span style={styles.label}>Context (optional)</span>
                <input style={styles.input} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Additional context for the agent..." />
              </div>
              <button style={btnStyle(loading || !task || !eoaAddress)} disabled={loading || !task || !eoaAddress} onClick={callAgent}>
                {loading ? "Agent working..." : "⚡ Call Agent ($0.001 USDC)"}
              </button>
            </div>

            {error && (
              <div style={{ marginTop: 16, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, padding: 16 }}>
                <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>❌ {error}</p>
              </div>
            )}

            {result && (
              <div style={{ marginTop: 16, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 12, padding: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <p style={{ color: "#10b981", fontWeight: 700, fontSize: 14, margin: 0 }}>✅ Agent Response</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={badgeStyle("#10b981")}>Paid {result.amountUSDC} USDC</span>
                    <span style={badgeStyle("#c8975a")}>ERC-8004 #{result.agent?.id}</span>
                  </div>
                </div>
                <div style={{ background: "#251c12", borderRadius: 10, padding: 16, fontSize: 14, lineHeight: 1.7, color: "#f0ece6", whiteSpace: "pre-wrap" as const }}>
                  {result.resourceData?.result || JSON.stringify(result.resourceData, null, 2)}
                </div>
                {result.transaction && (
                  <a href={`https://testnet.arcscan.app/tx/${result.transaction}`} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginTop: 12, fontSize: 12, color: "#c8975a" }}>
                    View transaction on ArcScan →
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}