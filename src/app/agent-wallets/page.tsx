"use client";

// src/app/agent-wallets/page.tsx
// Frontend UI for Circle Agent Wallets — policy-controlled wallets with
// spending guardrails. Calls /api/agent/wallet (the route already built).

import React, { useState } from "react";
import Image from "next/image";

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";

const NAV = [
  { label: "Dashboard",     href: "/dashboard" },
  { label: "Homepage",      href: "/" },
  { label: "Transactions",  href: "/transactions" },
  { label: "Checkout",      href: "/checkout" },
  { label: "Escrow",        href: "/escrow" },
  { label: "Agents",        href: "/agents" },
  { label: "Agent Wallets", href: "/agent-wallets", active: true },
  { label: "Jobs",          href: "/jobs" },
  { label: "Support",       href: "/support" },
];

interface AgentWalletResult {
  agentWallet: {
    name: string;
    address: string;
    walletId: string;
    chain: string;
  };
  policy: {
    dailySpendLimitUSDC: string | null;
    allowedContracts: string[] | null;
  } | null;
  message: string;
}

export default function AgentWalletsPage() {
  const [activeTab, setActiveTab] = useState<"create" | "lookup">("create");

  // Create form state
  const [agentName, setAgentName] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [allowedContracts, setAllowedContracts] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<AgentWalletResult | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Lookup state
  const [lookupAddress, setLookupAddress] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const createAgentWallet = async () => {
    if (!agentName.trim()) {
      setCreateError("Agent name is required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const contractsArray = allowedContracts
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      const res = await fetch("/api/agent/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          agentName,
          dailySpendLimitUSDC: dailyLimit || undefined,
          allowedContracts: contractsArray.length > 0 ? contractsArray : undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to create Agent Wallet.");
      setCreateResult(data);
    } catch (e: any) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const lookupAgentWallet = async () => {
    if (!lookupAddress.trim()) {
      setLookupError("Wallet address is required.");
      return;
    }
    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const res = await fetch(`/api/agent/wallet?address=${lookupAddress}`, {
        headers: { "x-api-key": API_KEY },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Wallet not found.");
      setLookupResult(data);
    } catch (e: any) {
      setLookupError(e.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const S = {
    page:    { display: "flex", minHeight: "100vh", background: "#0e0b08", fontFamily: "Inter, system-ui, sans-serif", color: "#f0ece6" },
    aside:   { width: 220, minHeight: "100vh", background: "#1a1410", display: "flex", flexDirection: "column" as const, padding: "24px 14px", flexShrink: 0, position: "sticky" as const, top: 0, height: "100vh", overflowY: "auto" as const, borderRight: "1px solid #2d2015" },
    main:    { flex: 1, padding: "32px", overflowX: "hidden" as const },
    card:    { background: "#1a1410", border: "1px solid #2d2015", borderRadius: 16, padding: 24, marginBottom: 20 },
    input:   { width: "100%", padding: "10px 14px", background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 10, color: "#f0ece6", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box" as const, marginBottom: 10 },
    btn:     (disabled = false) => ({ padding: "12px 24px", background: disabled ? "rgba(200,151,90,0.3)" : "#c8975a", color: disabled ? "rgba(14,11,8,0.5)" : "#0e0b08", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer" },
    tab:     (active: boolean) => ({ padding: "8px 16px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: `1px solid ${active ? "#c8975a" : "#2d2015"}`, background: active ? "rgba(200,151,90,0.1)" : "transparent", color: active ? "#c8975a" : "#6b5a45", fontWeight: active ? 700 : 400 }),
    label:   { fontSize: 10, color: "#6b5a45", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4, display: "block" as const },
  };

  return (
    <div style={S.page}>
      {/* Sidebar */}
      <aside style={S.aside}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <Image src="/arcflare-logo.png" alt="ArcFlare" width={36} height={36} style={{ borderRadius: 8, objectFit: "contain" }} />
          <div>
            <p style={{ color: "#f0ece6", fontSize: 14, fontWeight: 700, margin: 0 }}>ArcFlare</p>
            <p style={{ color: "#6b5a45", fontSize: 9, margin: 0 }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
          {NAV.map((item) => (
            <a key={item.label} href={item.href} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, textDecoration: "none", fontSize: 13, fontWeight: 500, background: (item as any).active ? "rgba(200,151,90,0.15)" : "transparent", color: (item as any).active ? "#c8975a" : "#6b5a45", border: (item as any).active ? "1px solid rgba(200,151,90,0.25)" : "1px solid transparent" }}>
              {item.label}
            </a>
          ))}
        </nav>
        <div style={{ marginTop: 12, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 10, padding: "8px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
            <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Arc Testnet Mode</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main style={S.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f0ece6", margin: "0 0 4px" }}>Agent Wallets</h1>
          <p style={{ color: "#6b5a45", fontSize: 13, margin: 0 }}>
            Policy-controlled wallets from Circle's Agent Stack — spending guardrails enforced by Circle, not your own code
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {(["create", "lookup"] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === "create" ? "⚡ Create Agent Wallet" : "🔍 Look Up Wallet"}
            </button>
          ))}
        </div>

        {/* ── CREATE TAB ── */}
        {activeTab === "create" && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#f0ece6", margin: "0 0 4px" }}>Create Policy-Controlled Agent Wallet</h3>
            <p style={{ color: "#6b5a45", fontSize: 12, margin: "0 0 20px" }}>
              Unlike standard Developer-Controlled Wallets, Agent Wallets can enforce daily spend limits and contract allowlists at the Circle infrastructure level.
            </p>

            <span style={S.label}>Agent Name</span>
            <input style={S.input} value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Procurement Bot" />

            <span style={S.label}>Daily Spend Limit (USDC) — optional</span>
            <input style={S.input} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="e.g. 10.00" />

            <span style={S.label}>Allowed Contracts — optional, comma-separated</span>
            <input style={S.input} value={allowedContracts} onChange={(e) => setAllowedContracts(e.target.value)} placeholder="0x24DAB3...,0xc9BbeD..." />

            <button style={{ ...S.btn(creating), marginTop: 8 }} disabled={creating} onClick={createAgentWallet}>
              {creating ? "Creating on Arc Testnet..." : "⚡ Create Agent Wallet"}
            </button>

            {createError && (
              <div style={{ marginTop: 14, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: 14 }}>
                <p style={{ color: "#f87171", fontSize: 12, margin: 0 }}>❌ {createError}</p>
              </div>
            )}

            {createResult && (
              <div style={{ marginTop: 16, background: "rgba(200,151,90,0.06)", border: "1px solid rgba(200,151,90,0.2)", borderRadius: 14, padding: 20 }}>
                <p style={{ color: "#c8975a", fontWeight: 700, fontSize: 14, margin: "0 0 14px" }}>✅ Agent Wallet Created</p>
                {[
                  { label: "Agent Name", value: createResult.agentWallet.name },
                  { label: "Wallet Address", value: createResult.agentWallet.address },
                  { label: "Wallet ID", value: createResult.agentWallet.walletId },
                  { label: "Chain", value: createResult.agentWallet.chain },
                ].map((row) => (
                  <div key={row.label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #2d2015" }}>
                    <span style={{ color: "#6b5a45", fontSize: 12 }}>{row.label}</span>
                    <span style={{ color: "#f0ece6", fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" as const, textAlign: "right" as const, maxWidth: "60%" }}>{row.value}</span>
                  </div>
                ))}

                {createResult.policy && (
                  <div style={{ marginTop: 14, background: "#251c12", borderRadius: 10, padding: 14 }}>
                    <p style={{ color: "#06b6d4", fontSize: 11, fontWeight: 700, margin: "0 0 8px", textTransform: "uppercase" as const, letterSpacing: 1 }}>Spending Policy Applied</p>
                    {createResult.policy.dailySpendLimitUSDC && (
                      <p style={{ color: "#f0ece6", fontSize: 12, margin: "0 0 4px" }}>Daily limit: <strong style={{ color: "#c8975a" }}>{createResult.policy.dailySpendLimitUSDC} USDC</strong></p>
                    )}
                    {createResult.policy.allowedContracts && (
                      <p style={{ color: "#f0ece6", fontSize: 12, margin: 0 }}>Allowed contracts: <strong style={{ color: "#c8975a" }}>{createResult.policy.allowedContracts.length}</strong></p>
                    )}
                  </div>
                )}

                <a
                  href={`https://testnet.arcscan.app/address/${createResult.agentWallet.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "block", marginTop: 14, textAlign: "center", padding: "10px", background: "rgba(200,151,90,0.1)", border: "1px solid rgba(200,151,90,0.25)", borderRadius: 8, color: "#c8975a", fontSize: 12, textDecoration: "none", fontWeight: 600 }}
                >
                  View on ArcScan →
                </a>
              </div>
            )}
          </div>
        )}

        {/* ── LOOKUP TAB ── */}
        {activeTab === "lookup" && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#f0ece6", margin: "0 0 16px" }}>Look Up Agent Wallet</h3>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <input style={{ ...S.input, marginBottom: 0, flex: 1 }} value={lookupAddress} onChange={(e) => setLookupAddress(e.target.value)} placeholder="0xWalletAddress..." />
              <button style={{ ...S.btn(lookupLoading), whiteSpace: "nowrap" as const }} disabled={lookupLoading} onClick={lookupAgentWallet}>
                {lookupLoading ? "Loading..." : "Look Up"}
              </button>
            </div>

            {lookupError && <p style={{ color: "#f87171", fontSize: 12 }}>❌ {lookupError}</p>}

            {lookupResult && (
              <div style={{ background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 14, padding: 20 }}>
                <p style={{ color: "#c8975a", fontWeight: 700, fontSize: 13, margin: "0 0 12px" }}>Wallet Details</p>
                <pre style={{ color: "#f0ece6", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" as const, margin: 0, overflowX: "auto" as const }}>
                  {JSON.stringify(lookupResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
