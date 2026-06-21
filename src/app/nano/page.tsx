"use client";

// src/app/nano/page.tsx
// Frontend for Nanopayments — record micro-charges and batch settle onchain.

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
  { label: "Agent Wallets", href: "/agent-wallets" },
  { label: "Jobs",          href: "/jobs" },
  { label: "Nanopayments",  href: "/nano", active: true },
  { label: "Payroll",       href: "/payroll" },
  { label: "Scheduled",     href: "/scheduled" },
  { label: "Support",       href: "/support" },
];

export default function NanoPaymentsPage() {
  const [activeTab, setActiveTab] = useState<"record" | "balance" | "settle">("record");

  // Record state
  const [agentSCA, setAgentSCA] = useState("0x7a8214dad7630a7a39054e0121acdbc7a65821c9");
  const [merchantSCA, setMerchantSCA] = useState("");
  const [amount, setAmount] = useState("0.0001");
  const [description, setDescription] = useState("1 API call");
  const [recording, setRecording] = useState(false);
  const [recordResult, setRecordResult] = useState<any>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Balance state
  const [balLoading, setBalLoading] = useState(false);
  const [balResult, setBalResult] = useState<any>(null);
  const [balError, setBalError] = useState<string | null>(null);

  // Settle state
  const [settling, setSettling] = useState(false);
  const [settleResult, setSettleResult] = useState<any>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [forceSettle, setForceSettle] = useState(false);
  const [autoSettling, setAutoSettling] = useState(false);
  const [autoSettleResult, setAutoSettleResult] = useState<any>(null);

  const recordNano = async () => {
    setRecording(true);
    setRecordError(null);
    setRecordResult(null);
    try {
      const res = await fetch("/api/payments/nano", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ agentSCA, merchantSCA, amount, description }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setRecordResult(data);
    } catch (e: any) {
      setRecordError(e.message);
    } finally {
      setRecording(false);
    }
  };

  const checkBalance = async () => {
    setBalLoading(true);
    setBalError(null);
    setBalResult(null);
    try {
      const res = await fetch(`/api/payments/nano?agentSCA=${agentSCA}&merchantSCA=${merchantSCA}`, {
        headers: { "x-api-key": API_KEY },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setBalResult(data);
    } catch (e: any) {
      setBalError(e.message);
    } finally {
      setBalLoading(false);
    }
  };

  const settleBatch = async () => {
    setSettling(true);
    setSettleError(null);
    setSettleResult(null);
    try {
      const res = await fetch("/api/payments/nano/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ agentSCA, merchantSCA, forceSettle }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setSettleResult(data);
    } catch (e: any) {
      setSettleError(e.message);
    } finally {
      setSettling(false);
    }
  };

  const autoSettleAll = async () => {
    setAutoSettling(true);
    setAutoSettleResult(null);
    try {
      const res = await fetch("/api/payments/nano/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ autoSettle: true }),
      });
      const data = await res.json();
      setAutoSettleResult(data);
    } catch (e: any) {
      setAutoSettleResult({ success: false, error: e.message });
    } finally {
      setAutoSettling(false);
    }
  };

  const S = {
    page:    { display: "flex", minHeight: "100vh", background: "#0e0b08", fontFamily: "Inter, system-ui, sans-serif", color: "#f0ece6" },
    aside:   { width: 220, minHeight: "100vh", background: "#1a1410", display: "flex", flexDirection: "column" as const, padding: "24px 14px", flexShrink: 0, position: "sticky" as const, top: 0, height: "100vh", overflowY: "auto" as const, borderRight: "1px solid #2d2015" },
    main:    { flex: 1, padding: "32px", overflowX: "hidden" as const },
    card:    { background: "#1a1410", border: "1px solid #2d2015", borderRadius: 16, padding: 24, marginBottom: 20 },
    input:   { width: "100%", padding: "10px 14px", background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 10, color: "#f0ece6", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box" as const, marginBottom: 10 },
    btn:     (disabled = false) => ({ padding: "12px 24px", background: disabled ? "rgba(200,151,90,0.3)" : "#c8975a", color: disabled ? "rgba(14,11,8,0.5)" : "#0e0b08", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer" }),
    tab:     (active: boolean) => ({ padding: "8px 16px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: `1px solid ${active ? "#c8975a" : "#2d2015"}`, background: active ? "rgba(200,151,90,0.1)" : "transparent", color: active ? "#c8975a" : "#6b5a45", fontWeight: active ? 700 : 400 }),
    label:   { fontSize: 10, color: "#6b5a45", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4, display: "block" as const },
  };

  return (
    <div style={S.page}>
      <aside style={S.aside}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <Image src="/arcflare-logo.png.png" alt="ArcFlare" width={36} height={36} style={{ borderRadius: 8, objectFit: "contain" }} />
          <div>
            <p style={{ color: "#f0ece6", fontSize: 14, fontWeight: 700, margin: 0 }}>ArcFlare</p>
            <p style={{ color: "#6b5a45", fontSize: 9, margin: 0 }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, overflowY: "auto" as const }}>
          {NAV.map((item) => (
            <a key={item.label} href={item.href} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, textDecoration: "none", fontSize: 13, fontWeight: 500, background: (item as any).active ? "rgba(200,151,90,0.15)" : "transparent", color: (item as any).active ? "#c8975a" : "#6b5a45", border: (item as any).active ? "1px solid rgba(200,151,90,0.25)" : "1px solid transparent" }}>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      <main style={S.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f0ece6", margin: "0 0 4px" }}>Nanopayments</h1>
          <p style={{ color: "#6b5a45", fontSize: 13, margin: 0 }}>Micro-payments that batch automatically and settle onchain</p>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {(["record", "balance", "settle"] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === "record" ? "💸 Record Charge" : t === "balance" ? "📊 Check Balance" : "⚡ Settle Batch"}
            </button>
          ))}
        </div>

        {/* Shared agent/merchant fields */}
        <div style={S.card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <span style={S.label}>Agent SCA (payer)</span>
              <input style={S.input} value={agentSCA} onChange={(e) => setAgentSCA(e.target.value)} />
            </div>
            <div>
              <span style={S.label}>Merchant SCA (receiver)</span>
              <input style={S.input} value={merchantSCA} onChange={(e) => setMerchantSCA(e.target.value)} placeholder="0xMerchant..." />
            </div>
          </div>
        </div>

        {activeTab === "record" && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#f0ece6", margin: "0 0 16px" }}>Record a Micro-Charge</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
              <div><span style={S.label}>Amount (USDC)</span><input style={S.input} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
              <div><span style={S.label}>Description</span><input style={S.input} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            </div>
            <button style={S.btn(recording)} disabled={recording} onClick={recordNano}>
              {recording ? "Recording..." : "💸 Record Charge"}
            </button>
            {recordError && <p style={{ color: "#f87171", fontSize: 12, marginTop: 10 }}>❌ {recordError}</p>}
            {recordResult && (
              <div style={{ marginTop: 14, background: "rgba(200,151,90,0.06)", border: "1px solid rgba(200,151,90,0.2)", borderRadius: 10, padding: 16 }}>
                <p style={{ color: "#c8975a", fontWeight: 700, fontSize: 13, margin: "0 0 8px" }}>✅ Charge Recorded</p>
                <p style={{ color: "#f0ece6", fontSize: 12, margin: "0 0 4px" }}>Unsettled balance: <strong>{recordResult.unsettledBalance} USDC</strong> ({recordResult.unsettledCount} charges)</p>
                <p style={{ color: recordResult.readyToSettle ? "#10b981" : "#6b5a45", fontSize: 12, margin: 0 }}>{recordResult.message}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === "balance" && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#f0ece6", margin: "0 0 16px" }}>Check Unsettled Balance</h3>
            <button style={S.btn(balLoading)} disabled={balLoading} onClick={checkBalance}>
              {balLoading ? "Checking..." : "📊 Check Balance"}
            </button>
            {balError && <p style={{ color: "#f87171", fontSize: 12, marginTop: 10 }}>❌ {balError}</p>}
            {balResult && (
              <div style={{ marginTop: 14, background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 10, padding: 16 }}>
                <pre style={{ color: "#f0ece6", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" as const, margin: 0 }}>
                  {JSON.stringify(balResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {activeTab === "settle" && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#f0ece6", margin: "0 0 4px" }}>Settle Batch Onchain</h3>
            <p style={{ color: "#6b5a45", fontSize: 12, margin: "0 0 16px" }}>Moves real USDC for this agent-merchant pair on Arc Testnet.</p>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
              <input type="checkbox" checked={forceSettle} onChange={(e) => setForceSettle(e.target.checked)} />
              <span style={{ fontSize: 12, color: "#6b5a45" }}>Force settle below threshold</span>
            </label>

            <button style={{ ...S.btn(settling), marginRight: 10 }} disabled={settling} onClick={settleBatch}>
              {settling ? "Settling onchain..." : "⚡ Settle This Pair"}
            </button>
            <button style={{ padding: "12px 24px", background: "transparent", color: "#06b6d4", border: "1px solid #06b6d4", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: autoSettling ? "not-allowed" : "pointer" }} disabled={autoSettling} onClick={autoSettleAll}>
              {autoSettling ? "Settling all..." : "🔄 Auto-Settle All Pairs"}
            </button>

            {settleError && <p style={{ color: "#f87171", fontSize: 12, marginTop: 10 }}>❌ {settleError}</p>}
            {settleResult && (
              <div style={{ marginTop: 14, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 10, padding: 16 }}>
                <p style={{ color: "#10b981", fontWeight: 700, fontSize: 13, margin: "0 0 8px" }}>✅ {settleResult.message}</p>
                <a href={settleResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#c8975a", fontSize: 11, fontFamily: "monospace" }}>View tx on ArcScan →</a>
              </div>
            )}
            {autoSettleResult && (
              <div style={{ marginTop: 14, background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 10, padding: 16 }}>
                <pre style={{ color: "#f0ece6", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" as const, margin: 0 }}>
                  {JSON.stringify(autoSettleResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
