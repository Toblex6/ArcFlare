"use client";

// src/app/scheduled/page.tsx
// Frontend for Recurring/Scheduled Payments.

import React, { useEffect, useState } from "react";
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
  { label: "Nanopayments",  href: "/nano" },
  { label: "Payroll",       href: "/payroll" },
  { label: "Scheduled",     href: "/scheduled", active: true },
  { label: "Support",       href: "/support" },
];

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "#10b981", PAUSED: "#f59e0b", CANCELLED: "#f87171", COMPLETED: "#06b6d4",
};

export default function ScheduledPaymentsPage() {
  const [activeTab, setActiveTab] = useState<"create" | "list">("list");

  // Create form
  const [payerSCA, setPayerSCA] = useState("0x7a8214dad7630a7a39054e0121acdbc7a65821c9");
  const [receiverSCA, setReceiverSCA] = useState("");
  const [amount, setAmount] = useState("");
  const [intervalDays, setIntervalDays] = useState("7");
  const [maxRuns, setMaxRuns] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<any>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // List
  const [schedules, setSchedules] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const loadSchedules = async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/payments/scheduled", { headers: { "x-api-key": API_KEY } });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setSchedules(data.scheduledPayments || []);
    } catch (e: any) {
      setListError(e.message);
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => { loadSchedules(); }, []);

  const createSchedule = async () => {
    setCreating(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const res = await fetch("/api/payments/scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          payerSCA, receiverSCA, amount, intervalDays: parseInt(intervalDays),
          maxRuns: maxRuns || undefined, description,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setCreateResult(data);
      loadSchedules();
    } catch (e: any) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const cancelSchedule = async (reference: string) => {
    try {
      await fetch("/api/payments/scheduled", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ reference }),
      });
      loadSchedules();
    } catch {}
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
      <aside style={S.aside}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <Image src="/arcflare-logo.png" alt="ArcFlare" width={36} height={36} style={{ borderRadius: 8, objectFit: "contain" }} />
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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f0ece6", margin: "0 0 4px" }}>Recurring Payments</h1>
          <p style={{ color: "#6b5a45", fontSize: 13, margin: 0 }}>Schedule USDC payments to run automatically every N days</p>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {(["list", "create"] as const).map((t) => (
            <button key={t} style={S.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t === "list" ? "📋 All Schedules" : "⚡ Create New"}
            </button>
          ))}
        </div>

        {activeTab === "create" && (
          <div style={S.card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div><span style={S.label}>Payer SCA</span><input style={S.input} value={payerSCA} onChange={(e) => setPayerSCA(e.target.value)} /></div>
              <div><span style={S.label}>Receiver SCA</span><input style={S.input} value={receiverSCA} onChange={(e) => setReceiverSCA(e.target.value)} placeholder="0xReceiver..." /></div>
              <div><span style={S.label}>Amount (USDC)</span><input style={S.input} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5.00" /></div>
              <div><span style={S.label}>Interval (days)</span><input style={S.input} value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} placeholder="7" /></div>
              <div><span style={S.label}>Max Runs (optional)</span><input style={S.input} value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} placeholder="Leave blank for infinite" /></div>
              <div><span style={S.label}>Description</span><input style={S.input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Weekly subscription" /></div>
            </div>
            <button style={S.btn(creating)} disabled={creating} onClick={createSchedule}>
              {creating ? "Creating..." : "⚡ Create Schedule"}
            </button>
            {createError && <p style={{ color: "#f87171", fontSize: 12, marginTop: 10 }}>❌ {createError}</p>}
            {createResult && (
              <div style={{ marginTop: 14, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 10, padding: 16 }}>
                <p style={{ color: "#10b981", fontWeight: 700, fontSize: 13, margin: 0 }}>✅ {createResult.message}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === "list" && (
          <div style={S.card}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#f0ece6", margin: "0 0 16px" }}>All Scheduled Payments</h3>
            {listLoading && <p style={{ color: "#6b5a45", fontSize: 12 }}>Loading...</p>}
            {listError && <p style={{ color: "#f87171", fontSize: 12 }}>❌ {listError}</p>}
            {!listLoading && schedules.length === 0 && (
              <p style={{ color: "#6b5a45", fontSize: 13, textAlign: "center" as const, padding: "30px 0" }}>No scheduled payments yet.</p>
            )}
            {schedules.map((s) => (
              <div key={s.id} style={{ background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 12, padding: 16, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ color: "#f0ece6", fontWeight: 700, fontSize: 13 }}>{s.description || s.reference}</span>
                  <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 12, background: `${STATUS_COLORS[s.status]}15`, color: STATUS_COLORS[s.status], fontWeight: 700 }}>{s.status}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, fontSize: 11 }}>
                  <div><span style={{ color: "#6b5a45" }}>Amount</span><p style={{ color: "#c8975a", margin: "2px 0 0", fontFamily: "monospace" }}>{s.amount} USDC</p></div>
                  <div><span style={{ color: "#6b5a45" }}>Every</span><p style={{ color: "#f0ece6", margin: "2px 0 0" }}>{s.intervalDays} day(s)</p></div>
                  <div><span style={{ color: "#6b5a45" }}>Runs</span><p style={{ color: "#f0ece6", margin: "2px 0 0" }}>{s.runCount}{s.maxRuns ? `/${s.maxRuns}` : ""}</p></div>
                  <div><span style={{ color: "#6b5a45" }}>Next Run</span><p style={{ color: "#06b6d4", margin: "2px 0 0", fontSize: 10 }}>{new Date(s.nextRunAt).toLocaleString()}</p></div>
                </div>
                {s.status === "ACTIVE" && (
                  <button onClick={() => cancelSchedule(s.reference)} style={{ marginTop: 10, padding: "6px 14px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#f87171", fontSize: 11, cursor: "pointer" }}>
                    Cancel Schedule
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
