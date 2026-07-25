// src/app/agent-services/page.tsx
"use client";

import React, { useState, useEffect } from "react";
import DashboardSidebar from "@/src/components/DashboardSidebar";
import Image from "next/image";

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";
const API_BASE = "https://flarehq.xyz";

// ── Navigation config (shared across pages) ──
const NAV_SECTIONS = [
  {
    group: "CORE",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: <span>📊</span> },
      { label: "Homepage", href: "/", icon: <span>🏠</span> },
      { label: "Transactions", href: "/transactions", icon: <span>📋</span> },
      { label: "Checkout", href: "/checkout", icon: <span>🛒</span> },
      { label: "Escrow", href: "/escrow", icon: <span>🔒</span> },
    ],
  },
  {
    group: "AGENTS & COMMERCE",
    items: [
      { label: "Agents", href: "/agents", icon: <span>🤖</span> },
      { label: "AI Agent", href: "/agent-brain", icon: <span>🧠</span> },
      { label: "Agent Wallets", href: "/agent-wallets", icon: <span>💳</span> },
      { label: "Jobs", href: "/jobs", icon: <span>💼</span> },
      { label: "Nanopayments", href: "/nano", icon: <span>⚡</span> },
    ],
  },
  {
    group: "BUSINESS",
    items: [
      { label: "Payroll", href: "/payroll", icon: <span>💰</span> },
      { label: "Scheduled", href: "/scheduled", icon: <span>📅</span> },
      { label: "Consumer (Flow)", href: "/consumer", icon: <span>📱</span> },
    ],
  },
  {
    group: null,
    items: [{ label: "Support", href: "/support", icon: <span>❓</span> }],
  },
];

interface AgentInfo {
  agentId: string;
  ownerAddress: string;
  reputationScore: number | null;
  pricing: { perRequest: string };
  availableTasks: string[];
}

const styles = {
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
      .catch(() => { });
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
    <div style={{ display: "flex", minHeight: "100vh", background: "#f8fafc" }}>
      <DashboardSidebar active="AI Agent" />
      <main style={{ flex: 1, minWidth: 0, padding: "24px", overflowX: "hidden" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
              <h1 style={{ fontSize: "clamp(20px, 4vw, 28px)", fontWeight: 700, margin: 0 }}>FlareHQ AI Agent</h1>
              <span style={badgeStyle("#10b981")}>ERC-8004</span>
              <span style={badgeStyle("#c8975a")}>x402 Paid</span>
            </div>
            <p style={{ color: "#6b5a45", fontSize: "clamp(12px, 1.2vw, 14px)", margin: 0 }}>
              An autonomous AI agent with onchain identity — pays get settled via Circle Gateway Nanopayments
            </p>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
            <button style={tabStyle(activeTab === "info")} onClick={() => setActiveTab("info")}>🤖 Agent Info</button>
            <button style={tabStyle(activeTab === "call")} onClick={() => setActiveTab("call")}>⚡ Call Agent</button>
          </div>

          {activeTab === "info" && (
            <div style={styles.card}>
              {agentInfo ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 20 }}>
                    {[
                      { label: "Agent ID (ERC-8004)", value: agentInfo.agentId },
                      { label: "Owner Address", value: agentInfo.ownerAddress },
                      { label: "Reputation Score", value: agentInfo.reputationScore !== null ? `${agentInfo.reputationScore}/100` : "Not yet recorded" },
                      { label: "Price per Request", value: agentInfo.pricing?.perRequest || "$0.001 USDC" },
                    ].map((row) => (
                      <div key={row.label} style={{ background: "#251c12", borderRadius: 12, padding: 16 }}>
                        <p style={{ fontSize: 10, color: "#6b5a45", textTransform: "uppercase" as const, letterSpacing: 1, margin: "0 0 6px" }}>{row.label}</p>
                        <p style={{ fontSize: "clamp(12px, 1vw, 14px)", color: "#c8975a", fontFamily: "monospace", margin: 0, wordBreak: "break-all" as const }}>{row.value}</p>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p style={styles.label}>Available Tasks</p>
                    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
                      {(agentInfo.availableTasks || []).map((t: string) => (
                        <span
                          key={t}
                          style={{
                            fontSize: 12,
                            padding: "6px 12px",
                            borderRadius: 20,
                            background: "rgba(200,151,90,0.08)",
                            border: "1px solid rgba(200,151,90,0.2)",
                            color: "#c8975a",
                            cursor: "pointer",
                          }}
                          onClick={() => { setTask(t); setActiveTab("call"); }}
                        >
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

          {activeTab === "call" && (
            <div style={styles.card}>
              <h3 style={{ fontSize: "clamp(16px, 1.5vw, 20px)", fontWeight: 700, margin: "0 0 20px" }}>Call the AI Agent</h3>
              <p style={{ color: "#6b5a45", fontSize: "clamp(12px, 1.2vw, 14px)", margin: "0 0 20px" }}>
                This costs $0.001 USDC per call, paid via x402 from your EOA Gateway balance.
              </p>

              <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                <div>
                  <span style={styles.label}>Your EOA Wallet Address (needs Gateway balance)</span>
                  <input style={styles.input} value={eoaAddress} onChange={(e) => setEoaAddress(e.target.value)} placeholder="0x..." />
                </div>
                <div>
                  <span style={styles.label}>Task</span>
                  <textarea style={{ ...styles.input, height: 80, resize: "vertical" as const }} value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Analyze the best payment strategy for a small freelance business using FlareHQ" />
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                    <p style={{ color: "#10b981", fontWeight: 700, fontSize: "clamp(14px, 1.2vw, 18px)", margin: 0 }}>✅ Agent Response</p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <span style={badgeStyle("#10b981")}>Paid {result.amountUSDC} USDC</span>
                      <span style={badgeStyle("#c8975a")}>ERC-8004 #{result.agent?.id}</span>
                    </div>
                  </div>
                  <div style={{ background: "#251c12", borderRadius: 10, padding: 16, fontSize: "clamp(13px, 1vw, 15px)", lineHeight: 1.7, color: "#f0ece6", whiteSpace: "pre-wrap" as const }}>
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
        </div>
      </main>
    </div>
  );
}
