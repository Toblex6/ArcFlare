"use client";

// src/app/nano/page.tsx
// Combined: Traditional Nanopayments (record + settle) + x402 Gateway Dashboard

import React, { useState, useEffect } from "react";
import Image from "next/image";
import DashboardSidebar from '@/components/DashboardSidebar';

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";

// resolveMerchant() fails closed if x-api-key is present but doesn't match —
// it will NOT fall back to the merchant_token cookie in that case. Only
// attach the header when we actually have a real key; otherwise the
// dashboard cookie session (the correct production path) does the auth.
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return API_KEY ? { ...extra, "x-api-key": API_KEY } : extra;
}

const NAV = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Homepage", href: "/" },
  { label: "Transactions", href: "/transactions" },
  { label: "Checkout", href: "/checkout" },
  { label: "Escrow", href: "/escrow" },
  { label: "Agents", href: "/agents" },
  { label: "Agent Wallets", href: "/agent-wallets" },
  { label: "Jobs", href: "/jobs" },
  { label: "Nanopayments", href: "/nano", active: true },
  { label: "Payroll", href: "/payroll" },
  { label: "Scheduled", href: "/scheduled" },
  { label: "Support", href: "/support" },
];

// ── Types ──────────────────────────────────────────────────────────────
interface BalanceData {
  wallet: { formatted: string };
  gateway: { formattedAvailable: string; formattedTotal: string };
}

interface PaymentLog {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  chain: string;
  senderEmail: string;
  merchant: string;
  status: string;
  arcTxHash: string | null;
  timestamp: string;
}

interface PayResult {
  success: boolean;
  paidWith?: string;
  amountUSDC?: string;
  transaction?: string;
  resourceData?: any;
  message?: string;
  error?: string;
  details?: any;
}

// ── Style Helpers ─────────────────────────────────────────────────────
const styles = {
  page: {
    display: "flex",
    minHeight: "100vh",
    background: "var(--background)",
    fontFamily: "Inter, system-ui, sans-serif",
    color: "var(--text)",
  } as React.CSSProperties,
  aside: {
    width: 220,
    minHeight: "100vh",
    background: "var(--surface)",
    display: "flex",
    flexDirection: "column" as const,
    padding: "24px 14px",
    flexShrink: 0,
    position: "sticky" as const,
    top: 0,
    height: "100vh",
    overflowY: "auto" as const,
    borderRight: "1px solid var(--border)",
  } as React.CSSProperties,
  main: {
    flex: 1,
    padding: "32px",
    overflowX: "hidden" as const,
  } as React.CSSProperties,
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
  } as React.CSSProperties,
  input: {
    width: "100%",
    padding: "10px 14px",
    background: "var(--surface-secondary)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "monospace",
    outline: "none",
    boxSizing: "border-box" as const,
    marginBottom: 10,
  } as React.CSSProperties,
  inputSmall: {
    padding: "10px 14px",
    background: "var(--surface-secondary)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "monospace",
    outline: "none",
    maxWidth: 120,
  } as React.CSSProperties,
  label: {
    fontSize: 10,
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 4,
    display: "block" as const,
  } as React.CSSProperties,
  balanceGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    marginBottom: 24,
  } as React.CSSProperties,
  balanceCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: 20,
  } as React.CSSProperties,
  balanceLabel: {
    color: "var(--text-secondary)",
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    margin: "0 0 6px",
  } as React.CSSProperties,
  balanceValue: {
    fontSize: 28,
    fontWeight: 700,
    fontFamily: "monospace",
    margin: 0,
  } as React.CSSProperties,
  balanceUnit: { color: "var(--primary)", fontSize: 16 },
  balanceSub: { color: "var(--text-secondary)", fontSize: 12, margin: "6px 0 0" },
  row: { display: "flex", gap: 10, flexWrap: "wrap" as const },
  errorBox: {
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.2)",
    borderRadius: 10,
    padding: 12,
    color: "var(--danger)",
    marginBottom: 16,
  } as React.CSSProperties,
  successBox: {
    background: "rgba(16,185,129,0.06)",
    border: "1px solid rgba(16,185,129,0.2)",
    borderRadius: 10,
    padding: 12,
    color: "var(--success)",
    marginBottom: 16,
  } as React.CSSProperties,
  tableWrap: { overflowX: "auto" as const },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
    fontFamily: "monospace",
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "8px 8px 8px 0",
    color: "var(--text-secondary)",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  tdRef: { color: "var(--primary)", padding: "8px 8px 8px 0" },
  tdAmount: { color: "var(--text)", padding: "8px 8px 8px 0" },
  tdAddress: { color: "var(--text-secondary)", padding: "8px 8px 8px 0" },
  tdMerchant: { color: "var(--text)", padding: "8px 8px 8px 0" },
  explorerLink: {
    color: "var(--primary)",
    textDecoration: "none",
    fontSize: 12,
  } as React.CSSProperties,
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`,
  background: active ? "rgba(200,151,90,0.1)" : "transparent",
  color: active ? "var(--primary)" : "var(--text-secondary)",
  fontWeight: active ? 700 : 400,
});

const btnStyle = (disabled = false): React.CSSProperties => ({
  padding: "12px 24px",
  background: disabled ? "rgba(200,151,90,0.3)" : "var(--primary)",
  color: disabled ? "rgba(14,11,8,0.5)" : "var(--background)",
  border: "none",
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 13,
  cursor: disabled ? "not-allowed" : "pointer",
});

const btnGhostStyle = (disabled = false): React.CSSProperties => ({
  padding: "12px 24px",
  background: "transparent",
  color: "#06b6d4",
  border: "1px solid #06b6d4",
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 13,
  cursor: disabled ? "not-allowed" : "pointer",
});

const badgeStyle = (status: string): React.CSSProperties => {
  const base = { padding: "2px 10px", borderRadius: 12, fontSize: 11, fontWeight: 700 };
  if (status === "SUCCESS") return { ...base, background: "rgba(16,185,129,0.12)", color: "var(--success)" };
  if (status === "PENDING") return { ...base, background: "rgba(245,158,11,0.12)", color: "var(--warning)" };
  return { ...base, background: "rgba(239,68,68,0.12)", color: "var(--danger)" };
};

const payResultBoxStyle = (success: boolean): React.CSSProperties => ({
  marginTop: 12,
  background: success ? "rgba(16,185,129,0.06)" : "rgba(239,68,68,0.08)",
  border: success ? "1px solid rgba(16,185,129,0.2)" : "1px solid rgba(239,68,68,0.2)",
  borderRadius: 10,
  padding: 16,
  color: success ? "var(--success)" : "var(--danger)",
});

export default function NanoPaymentsPage() {
  const [activeTab, setActiveTab] = useState<"record" | "x402">("record");

  // ── Traditional Nanopayments State ──────────────────────────────────
  const [agentSCA, setAgentSCA] = useState("0x7a8214dad7630a7a39054e0121acdbc7a65821c9");
  const [merchantSCA, setMerchantSCA] = useState("");
  const [amount, setAmount] = useState("0.0001");
  const [description, setDescription] = useState("1 API call");
  const [recording, setRecording] = useState(false);
  const [recordResult, setRecordResult] = useState<any>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  const [balLoading, setBalLoading] = useState(false);
  const [balResult, setBalResult] = useState<any>(null);
  const [balError, setBalError] = useState<string | null>(null);

  const [settling, setSettling] = useState(false);
  const [settleResult, setSettleResult] = useState<any>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [forceSettle, setForceSettle] = useState(false);
  const [autoSettling, setAutoSettling] = useState(false);
  const [autoSettleResult, setAutoSettleResult] = useState<any>(null);

  // ── x402 State ──────────────────────────────────────────────────────
  const [x402Balances, setX402Balances] = useState<BalanceData | null>(null);
  const [x402Payments, setX402Payments] = useState<PaymentLog[]>([]);
  const [x402Loading, setX402Loading] = useState(true);

  const [depositAmount, setDepositAmount] = useState("1");
  const [depositing, setDepositing] = useState(false);
  const [depositResult, setDepositResult] = useState<any>(null);

  const [resourceUrl, setResourceUrl] = useState(
    "/api/nano/pay/agent-lookup?scaAddress=0x7a8214dad7630a7a39054e0121acdbc7a65821c9"
  );
  const [paying, setPaying] = useState(false);
  const [payResult, setPayResult] = useState<PayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Traditional Handlers ────────────────────────────────────────────
  const recordNano = async () => {
    setRecording(true);
    setRecordError(null);
    setRecordResult(null);
    try {
      const res = await fetch("/api/payments/nano", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
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
      const res = await fetch(
        `/api/payments/nano?agentSCA=${agentSCA}&merchantSCA=${merchantSCA}`,
        { headers: authHeaders() }
      );
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
        headers: authHeaders({ "Content-Type": "application/json" }),
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
        headers: authHeaders({ "Content-Type": "application/json" }),
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

  // ── x402 Handlers ──────────────────────────────────────────────────
  const fetchX402Data = async () => {
    setX402Loading(true);
    setError(null);
    try {
      // 1. Fetch balances – required
      const balanceRes = await fetch("/api/x402/seller/balance", {
        headers: authHeaders(),
      });
      const balanceData = await balanceRes.json();
      if (balanceData.success) setX402Balances(balanceData);

      // 2. Fetch payment history – optional, fallback on error
      try {
        const paymentsRes = await fetch("/api/payments/all?chain=x402", {
          headers: authHeaders(),
        });
        const paymentsData = await paymentsRes.json();
        if (paymentsData.success) setX402Payments(paymentsData.data || []);
      } catch {
        // If history fetch fails, just use an empty array
        setX402Payments([]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setX402Loading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "x402") {
      fetchX402Data();
      const interval = setInterval(fetchX402Data, 15000);
      return () => clearInterval(interval);
    }
  }, [activeTab]);

  const handleDeposit = async () => {
    if (!depositAmount) {
      setError("Please enter an amount.");
      return;
    }
    setDepositing(true);
    setDepositResult(null);
    setError(null);
    try {
      const res = await fetch("/api/x402/eoa-wallet/deposit", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ amount: depositAmount }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setDepositResult(data);
      fetchX402Data();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDepositing(false);
    }
  };

  const handlePay = async () => {
    if (!resourceUrl) {
      setError("Please enter a resource URL.");
      return;
    }
    setPaying(true);
    setPayResult(null);
    setError(null);
    try {
      const res = await fetch("/api/x402/pay", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ resourceUrl }),
      });
      const data = await res.json();
      setPayResult(data);
      if (data.success) fetchX402Data();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="light" style={styles.page}>
      {/* ── Sidebar ── */}
      <DashboardSidebar active="Nanopayments" />

      {/* ── Main ── */}
      <main style={styles.main}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
            Nanopayments
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>
            Micro-payments that batch automatically + gasless x402 Gateway payments
          </p>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          <button style={tabStyle(activeTab === "record")} onClick={() => setActiveTab("record")}>
            💸 Record & Settle
          </button>
          <button style={tabStyle(activeTab === "x402")} onClick={() => setActiveTab("x402")}>
            ⚡ x402 Gateway
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 1: Traditional Nanopayments                                */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "record" && (
          <>
            {/* Shared agent/merchant fields */}
            <div style={styles.card}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <span style={styles.label}>Agent SCA (payer)</span>
                  <input style={styles.input} value={agentSCA} onChange={(e) => setAgentSCA(e.target.value)} />
                </div>
                <div>
                  <span style={styles.label}>Merchant SCA (receiver)</span>
                  <input
                    style={styles.input}
                    value={merchantSCA}
                    onChange={(e) => setMerchantSCA(e.target.value)}
                    placeholder="0xMerchant..."
                  />
                </div>
              </div>
            </div>

            {/* Record */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 16px" }}>
                Record a Micro-Charge
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <span style={styles.label}>Amount (USDC)</span>
                  <input style={styles.input} value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div>
                  <span style={styles.label}>Description</span>
                  <input
                    style={styles.input}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>
              <button style={btnStyle(recording)} disabled={recording} onClick={recordNano}>
                {recording ? "Recording..." : "💸 Record Charge"}
              </button>
              {recordError && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>❌ {recordError}</p>}
              {recordResult && (
                <div style={{ marginTop: 14, background: "rgba(200,151,90,0.06)", border: "1px solid rgba(200,151,90,0.2)", borderRadius: 10, padding: 16 }}>
                  <p style={{ color: "var(--primary)", fontWeight: 700, fontSize: 13, margin: "0 0 8px" }}>✅ Charge Recorded</p>
                  <p style={{ color: "var(--text)", fontSize: 12, margin: "0 0 4px" }}>
                    Unsettled balance: <strong>{recordResult.unsettledBalance} USDC</strong> ({recordResult.unsettledCount} charges)
                  </p>
                  <p style={{ color: recordResult.readyToSettle ? "var(--success)" : "var(--text-secondary)", fontSize: 12, margin: 0 }}>
                    {recordResult.message}
                  </p>
                </div>
              )}
            </div>

            {/* Check Balance */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 16px" }}>
                Check Unsettled Balance
              </h3>
              <button style={btnStyle(balLoading)} disabled={balLoading} onClick={checkBalance}>
                {balLoading ? "Checking..." : "📊 Check Balance"}
              </button>
              {balError && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>❌ {balError}</p>}
              {balResult && (
                <div style={{ marginTop: 14, background: "var(--surface-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                  <pre style={{ color: "var(--text)", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" as const, margin: 0 }}>
                    {JSON.stringify(balResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Settle Batch */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
                Settle Batch Onchain
              </h3>
              <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 16px" }}>
                Moves real USDC for this agent-merchant pair on Arc Testnet.
              </p>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
                <input type="checkbox" checked={forceSettle} onChange={(e) => setForceSettle(e.target.checked)} />
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Force settle below threshold</span>
              </label>
              <button style={{ ...btnStyle(settling), marginRight: 10 }} disabled={settling} onClick={settleBatch}>
                {settling ? "Settling onchain..." : "⚡ Settle This Pair"}
              </button>
              <button style={btnGhostStyle(autoSettling)} disabled={autoSettling} onClick={autoSettleAll}>
                {autoSettling ? "Settling all..." : "🔄 Auto-Settle All Pairs"}
              </button>
              {settleError && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>❌ {settleError}</p>}
              {settleResult && (
                <div style={{ marginTop: 14, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 10, padding: 16 }}>
                  <p style={{ color: "var(--success)", fontWeight: 700, fontSize: 13, margin: "0 0 8px" }}>✅ {settleResult.message}</p>
                  <a href={settleResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.explorerLink}>
                    View tx on ArcScan →
                  </a>
                </div>
              )}
              {autoSettleResult && (
                <div style={{ marginTop: 14, background: "var(--surface-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                  <pre style={{ color: "var(--text)", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" as const, margin: 0 }}>
                    {JSON.stringify(autoSettleResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 2: x402 Gateway                                            */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "x402" && (
          <>
            {error && <div style={styles.errorBox}>❌ {error}</div>}

            {/* ── BALANCE CARDS ── */}
            <div style={styles.balanceGrid}>
              <div style={styles.balanceCard}>
                <p style={styles.balanceLabel}>Gateway Balance (Seller)</p>
                <p style={styles.balanceValue}>
                  {x402Balances?.gateway?.formattedAvailable || "0.00"}{" "}
                  <span style={styles.balanceUnit}>USDC</span>
                </p>
                <p style={styles.balanceSub}>Total: {x402Balances?.gateway?.formattedTotal || "0.00"} USDC</p>
              </div>
              <div style={styles.balanceCard}>
                <p style={styles.balanceLabel}>Wallet Balance (Buyer)</p>
                <p style={styles.balanceValue}>
                  {x402Balances?.wallet?.formatted || "0.00"}{" "}
                  <span style={styles.balanceUnit}>USDC</span>
                </p>
                <p style={styles.balanceSub}>Fund via faucet.circle.com</p>
              </div>
            </div>

            {/* ── DEPOSIT ── */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
                💰 Deposit into Gateway
              </h3>
              <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 16px" }}>
                Transfer USDC from your x402 wallet into Circle Gateway (your wallet is resolved from your login, not entered manually).
              </p>
              <div style={styles.row}>
                <input
                  style={styles.inputSmall}
                  type="number"
                  placeholder="Amount"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                />
                <button style={btnStyle(depositing)} disabled={depositing} onClick={handleDeposit}>
                  {depositing ? "Depositing..." : "Deposit"}
                </button>
              </div>
              {depositResult && (
                <div style={styles.successBox}>
                  ✅ Deposited {depositResult.amount} USDC.{" "}
                  <a href={depositResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.explorerLink}>
                    View on ArcScan →
                  </a>
                </div>
              )}
            </div>

            {/* ── PAY X402 ── */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
                🤖 Pay x402 Resource
              </h3>
              <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 16px" }}>
                Pay for a protected API endpoint using your x402 wallet (resolved from your login).
              </p>
              <div style={styles.row}>
                <input
                  style={{ ...styles.input, flex: 2 }}
                  placeholder="Resource URL (x402-protected endpoint)"
                  value={resourceUrl}
                  onChange={(e) => setResourceUrl(e.target.value)}
                />
                <button style={btnStyle(paying)} disabled={paying} onClick={handlePay}>
                  {paying ? "Paying..." : "Pay"}
                </button>
              </div>

              {payResult && (
                <div style={payResultBoxStyle(payResult.success)}>
                  {payResult.success ? (
                    <>
                      <p style={{ fontWeight: 700, margin: "0 0 6px" }}>✅ Payment successful!</p>
                      <p style={{ margin: "0 0 4px" }}>
                        Paid <strong>{payResult.amountUSDC} USDC</strong> from {payResult.paidWith?.slice(0, 12)}...
                      </p>
                      {payResult.transaction && (
                        <p style={{ color: "var(--text-secondary)", fontSize: 11, fontFamily: "monospace", margin: "0 0 4px" }}>
                          Settlement ref: {payResult.transaction.slice(0, 18)}...
                          <br />
                          <span style={{ fontFamily: "inherit" }}>
                            Gateway batches this onchain periodically — not yet a resolvable onchain tx hash.
                          </span>
                        </p>
                      )}
                      <div style={{ marginTop: 8, background: "var(--surface-secondary)", borderRadius: 8, padding: 10 }}>
                        <p style={{ color: "var(--text-secondary)", fontSize: 10, margin: "0 0 4px" }}>Resource Data:</p>
                        <pre style={{ color: "var(--text)", fontSize: 11, margin: 0, whiteSpace: "pre-wrap" as const }}>
                          {JSON.stringify(payResult.resourceData, null, 2)}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <>
                      <p style={{ fontWeight: 700, margin: "0 0 6px" }}>❌ Payment failed</p>
                      <p style={{ margin: 0 }}>{payResult.error || payResult.message || "Unknown error"}</p>
                      {payResult.details && (
                        <pre style={{ fontSize: 11, marginTop: 6, color: "var(--text)", background: "var(--surface-secondary)", padding: 8, borderRadius: 6 }}>
                          {JSON.stringify(payResult.details, null, 2)}
                        </pre>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── PAYMENT HISTORY ── */}
            <div style={styles.card}>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "0 0 16px" }}>
                📋 Recent x402 Payments
              </h3>
              {x402Loading ? (
                <p style={{ color: "var(--text-secondary)" }}>Loading...</p>
              ) : x402Payments.length === 0 ? (
                <p style={{ color: "var(--text-secondary)" }}>No x402 payments yet.</p>
              ) : (
                <div style={styles.tableWrap}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Reference</th>
                        <th style={styles.th}>Amount</th>
                        <th style={styles.th}>Payer</th>
                        <th style={styles.th}>Resource</th>
                        <th style={styles.th}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {x402Payments.map((p) => (
                        <tr key={p.id}>
                          <td style={styles.tdRef}>{p.reference.slice(0, 16)}...</td>
                          <td style={styles.tdAmount}>{p.amount} USDC</td>
                          <td style={styles.tdAddress}>{p.senderEmail.slice(0, 12)}...</td>
                          <td style={styles.tdMerchant}>{p.merchant}</td>
                          <td>
                            <span style={badgeStyle(p.status)}>{p.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}