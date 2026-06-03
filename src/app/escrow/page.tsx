"use client";

import React, { useEffect, useState } from "react";

interface EscrowItem {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  depositorSCA: string;
  beneficiarySCA: string;
  status: string;
  condition: string | null;
  deadline: string | null;
  timeRemaining: number | null;
  isExpired: boolean;
  txHash: string | null;
  releaseTxHash: string | null;
  disputeTxHash: string | null;
  disputeReason: string | null;
  depositorConfirmed: boolean;
  beneficiaryConfirmed: boolean;
  explorerUrl: string | null;
  createdAt: string;
}

interface EscrowMetrics {
  total: number;
  active: number;
  released: number;
  disputed: number;
  refunded: number;
  totalLocked: number;
  totalReleased: number;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  ACTIVE:   { bg: "rgba(13,124,95,0.12)",  text: "#0d7c5f", border: "rgba(13,124,95,0.3)"  },
  RELEASED: { bg: "rgba(16,185,129,0.12)", text: "#10b981", border: "rgba(16,185,129,0.3)" },
  DISPUTED: { bg: "rgba(245,158,11,0.12)", text: "#f59e0b", border: "rgba(245,158,11,0.3)" },
  REFUNDED: { bg: "rgba(107,114,128,0.12)",text: "#6b7280", border: "rgba(107,114,128,0.3)"},
};

function formatTime(seconds: number): string {
  if (seconds <= 0) return "Expired";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

export default function EscrowDashboard() {
  const [escrows, setEscrows] = useState<EscrowItem[]>([]);
  const [metrics, setMetrics] = useState<EscrowMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [selected, setSelected] = useState<EscrowItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchEscrows = async () => {
    try {
      const url =
        filter === "ALL"
          ? "/api/escrow/list"
          : `/api/escrow/list?status=${filter}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setEscrows(json.escrows);
        setMetrics(json.metrics);
        setError(null);
      } else {
        setError(json.error);
      }
    } catch {
      setError("Failed to load escrows.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEscrows();
    const interval = setInterval(fetchEscrows, 10000);
    return () => clearInterval(interval);
  }, [filter]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#0f1117", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#0d7c5f", fontFamily: "monospace", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>
          LOADING ESCROW LEDGER...
        </p>
      </div>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0f1117", color: "#e2e8f0", padding: "32px 24px", fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        .card { background: #1a2235; border: 1px solid #232d42; border-radius: 14px; }
        .card-inner { background: #111827; border: 1px solid #1e2a3a; border-radius: 10px; }
        .mono { font-family: 'DM Mono', monospace; }
        .hover-row:hover { background: rgba(255,255,255,0.03); cursor: pointer; }
        .filter-btn { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #232d42; background: transparent; color: #6b7280; transition: all 0.15s; }
        .filter-btn.active { background: rgba(13,124,95,0.15); border-color: #0d7c5f; color: #0d7c5f; font-weight: 600; }
        .filter-btn:hover { border-color: #0d7c5f; color: #0d7c5f; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      <div style={{ maxWidth: 1200, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <a href="/dashboard" style={{ color: "#4b5563", fontSize: 13, textDecoration: "none" }}>← Dashboard</a>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img src="/logo.png" alt="ArcFlare Logo" style={{ height: "32px", width: "auto" }} />
              <h1 style={{ fontSize: 22, fontWeight: 700, color: "#fff", margin: 0 }}>Escrow Management</h1>
            </div>
            <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
              Trustless USDC escrow on Arc Testnet via ArcFlareEscrow contract
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(13,124,95,0.1)", border: "1px solid rgba(13,124,95,0.25)", borderRadius: 20, padding: "5px 14px" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#0d7c5f", display: "inline-block", animation: "pulse 2s infinite" }} />
            <span style={{ fontSize: 11, color: "#0d7c5f", fontWeight: 600, fontFamily: "monospace", letterSpacing: 1 }}>ARC TESTNET LIVE</span>
          </div>
        </div>

        {/* Metric Cards */}
        {metrics && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
            {[
              { label: "Total Locked", value: `${metrics.totalLocked.toFixed(2)} USDC`, sub: `${metrics.active} active escrows`, color: "#0d7c5f" },
              { label: "Total Released", value: `${metrics.totalReleased.toFixed(2)} USDC`, sub: `${metrics.released} completed`, color: "#10b981" },
              { label: "Disputed", value: metrics.disputed.toString(), sub: "Pending admin review", color: "#f59e0b" },
              { label: "Refunded", value: metrics.refunded.toString(), sub: "Returned to depositor", color: "#6b7280" },
            ].map((m, i) => (
              <div key={i} className="card" style={{ padding: 18 }}>
                <p style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{m.label}</p>
                <p className="mono" style={{ fontSize: 22, fontWeight: 700, color: m.color, marginBottom: 4 }}>{m.value}</p>
                <p style={{ fontSize: 11, color: "#4b5563" }}>{m.sub}</p>
              </div>
            ))}
          </div>
        )}

        {/* Filter Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {["ALL", "ACTIVE", "RELEASED", "DISPUTED", "REFUNDED"].map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <button
            onClick={fetchEscrows}
            style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: "1px solid #232d42", background: "transparent", color: "#6b7280" }}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Main layout — table + detail panel */}
        <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 380px" : "1fr", gap: 20 }}>

          {/* Escrow Table */}
          <div className="card" style={{ padding: 24 }}>
            {error && (
              <p style={{ color: "#ef4444", fontSize: 12, fontFamily: "monospace", marginBottom: 16 }}>❌ {error}</p>
            )}

            {escrows.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <p style={{ fontSize: 32, marginBottom: 12 }}>🔒</p>
                <p style={{ color: "#4b5563", fontSize: 14 }}>No escrows found.</p>
                <p style={{ color: "#374151", fontSize: 12, marginTop: 4 }}>
                  Create an escrow via POST /api/escrow/create
                </p>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "monospace" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1e2a3a" }}>
                    {["Reference", "Parties", "Amount", "Condition", "Deadline", "Status", "Confirmations"].map((h) => (
                      <th key={h} style={{ textAlign: "left", paddingBottom: 12, paddingRight: 14, fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {escrows.map((e) => {
                    const sc = STATUS_COLORS[e.status] || STATUS_COLORS.ACTIVE;
                    return (
                      <tr
                        key={e.id}
                        className="hover-row"
                        style={{ borderBottom: "1px solid #111827" }}
                        onClick={() => setSelected(selected?.id === e.id ? null : e)}
                      >
                        {/* Reference */}
                        <td style={{ padding: "14px 14px 14px 0" }}>
                          <div style={{ color: "#0d7c5f" }}>{e.reference.slice(0, 14)}...</div>
                          <div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>
                            {new Date(e.createdAt).toLocaleDateString()}
                          </div>
                        </td>

                        {/* Parties */}
                        <td style={{ padding: "14px 14px 14px 0" }}>
                          <div style={{ color: "#e2e8f0" }}>📤 {e.depositorSCA.slice(0, 10)}...</div>
                          <div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>
                            {`📥 ${e.beneficiarySCA.slice(0, 10)}...`}
                          </div>
                        </td>

                        {/* Amount */}
                        <td style={{ padding: "14px 14px 14px 0" }}>
                          <div style={{ color: "#fff", fontWeight: 700 }}>{e.amount.toFixed(2)}</div>
                          <div style={{ color: "#f59e0b", fontSize: 10 }}>{e.currency}</div>
                        </td>

                        {/* Condition */}
                        <td style={{ padding: "14px 14px 14px 0", maxWidth: 140 }}>
                          <div style={{ color: "#9ca3af", fontSize: 10, wordBreak: "break-word" }}>
                            {e.condition || "No condition set"}
                          </div>
                        </td>

                        {/* Deadline */}
                        <td style={{ padding: "14px 14px 14px 0" }}>
                          {e.deadline ? (
                            <>
                              <div style={{ color: e.isExpired ? "#ef4444" : "#e2e8f0", fontSize: 11 }}>
                                {e.isExpired ? "⚠ Expired" : `⏱ ${formatTime(e.timeRemaining || 0)}`}
                              </div>
                              <div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>
                                {new Date(e.deadline).toLocaleDateString()}
                              </div>
                            </>
                          ) : (
                            <div style={{ color: "#4b5563", fontSize: 10 }}>No deadline</div>
                          )}
                        </td>

                        {/* Status */}
                        <td style={{ padding: "14px 14px 14px 0" }}>
                          <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: sc.bg, color: sc.text, border: `1px solid ${sc.border}` }}>
                            {e.status}
                          </span>
                        </td>

                        {/* Confirmations */}
                        <td style={{ padding: "14px 0" }}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: e.depositorConfirmed ? "rgba(13,124,95,0.15)" : "#111827", color: e.depositorConfirmed ? "#0d7c5f" : "#4b5563", border: `1px solid ${e.depositorConfirmed ? "rgba(13,124,95,0.3)" : "#1e2a3a"}` }}>
                              {e.depositorConfirmed ? "✓" : "○"} Dep
                            </span>
                            <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: e.beneficiaryConfirmed ? "rgba(13,124,95,0.15)" : "#111827", color: e.beneficiaryConfirmed ? "#0d7c5f" : "#4b5563", border: `1px solid ${e.beneficiaryConfirmed ? "rgba(13,124,95,0.3)" : "#1e2a3a"}` }}>
                              {e.beneficiaryConfirmed ? "✓" : "○"} Ben
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Detail Panel */}
          {selected && (
            <div className="card" style={{ padding: 24, alignSelf: "start" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Escrow Detail</h3>
                <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", color: "#4b5563", cursor: "pointer", fontSize: 18 }}>✕</button>
              </div>

              {/* Status badge */}
              {(() => {
                const sc = STATUS_COLORS[selected.status] || STATUS_COLORS.ACTIVE;
                return (
                  <span style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: sc.bg, color: sc.text, border: `1px solid ${sc.border}` }}>
                    ● {selected.status}
                  </span>
                );
              })()}

              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                {[
                  { label: "Reference", value: selected.reference },
                  { label: "Amount", value: `${selected.amount.toFixed(2)} ${selected.currency}` },
                  { label: "Depositor SCA", value: selected.depositorSCA },
                  { label: "Beneficiary SCA", value: selected.beneficiarySCA },
                  { label: "Condition", value: selected.condition || "None set" },
                  { label: "Deadline", value: selected.deadline ? new Date(selected.deadline).toLocaleString() : "None" },
                  { label: "Created", value: new Date(selected.createdAt).toLocaleString() },
                ].map((row) => (
                  <div key={row.label} className="card-inner" style={{ padding: 12 }}>
                    <p style={{ fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{row.label}</p>
                    <p style={{ fontSize: 12, color: "#e2e8f0", fontFamily: "monospace", wordBreak: "break-all" }}>{row.value}</p>
                  </div>
                ))}

                {/* Confirmations */}
                <div className="card-inner" style={{ padding: 12 }}>
                  <p style={{ fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Confirmations</p>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ flex: 1, textAlign: "center", padding: "8px", background: selected.depositorConfirmed ? "rgba(13,124,95,0.15)" : "#0f1117", borderRadius: 8, border: `1px solid ${selected.depositorConfirmed ? "rgba(13,124,95,0.3)" : "#1e2a3a"}` }}>
                      <p style={{ fontSize: 16, marginBottom: 4 }}>{selected.depositorConfirmed ? "✅" : "⏳"}</p>
                      <p style={{ fontSize: 10, color: selected.depositorConfirmed ? "#0d7c5f" : "#4b5563" }}>Depositor</p>
                    </div>
                    <div style={{ flex: 1, textAlign: "center", padding: "8px", background: selected.beneficiaryConfirmed ? "rgba(13,124,95,0.15)" : "#0f1117", borderRadius: 8, border: `1px solid ${selected.beneficiaryConfirmed ? "rgba(13,124,95,0.3)" : "#1e2a3a"}` }}>
                      <p style={{ fontSize: 16, marginBottom: 4 }}>{selected.beneficiaryConfirmed ? "✅" : "⏳"}</p>
                      <p style={{ fontSize: 10, color: selected.beneficiaryConfirmed ? "#0d7c5f" : "#4b5563" }}>Beneficiary</p>
                    </div>
                  </div>
                </div>

                {/* Explorer links */}
                {selected.explorerUrl && (
                  <a
                    href={selected.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "block", textAlign: "center", padding: "10px", background: "rgba(13,124,95,0.12)", border: "1px solid rgba(13,124,95,0.25)", borderRadius: 8, color: "#0d7c5f", fontSize: 12, textDecoration: "none", fontWeight: 600 }}
                  >
                    View on ArcScan →
                  </a>
                )}

                {/* Dispute reason */}
                {selected.disputeReason && (
                  <div className="card-inner" style={{ padding: 12, border: "1px solid rgba(245,158,11,0.3)" }}>
                    <p style={{ fontSize: 10, color: "#f59e0b", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Dispute Reason</p>
                    <p style={{ fontSize: 12, color: "#e2e8f0" }}>{selected.disputeReason}</p>
                    {selected.disputedBy && (
                      <p style={{ fontSize: 10, color: "#4b5563", marginTop: 4 }}>Raised by: {selected.disputedBy}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}