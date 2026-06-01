"use client";

import React, { useEffect, useState } from "react";

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

export default function TransactionsPage() {
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/payments/all")
      .then((r) => r.json())
      .then((json) => {
        if (json.status) setPayments(json.data);
        else setError(json.error);
      })
      .catch(() => setError("Failed to load transactions."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f8fafc", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* Sidebar — same as dashboard */}
      <aside style={{ width: 220, minHeight: "100vh", background: "#0f1117", display: "flex", flexDirection: "column", padding: "24px 14px", flexShrink: 0, position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <div style={{ width: 32, height: 32, background: "rgba(13,124,95,0.25)", border: "1px solid rgba(13,124,95,0.5)", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#0d7c5f", fontSize: 16, fontWeight: 800 }}>A</span>
          </div>
          <div>
            <p style={{ color: "#fff", fontSize: 14, fontWeight: 700, lineHeight: 1, margin: 0 }}>ArcFlare</p>
            <p style={{ color: "#4b5563", fontSize: 10, margin: "3px 0 0 0" }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
          {[
            { label: "Dashboard", href: "/dashboard", active: false },
            { label: "Payments", href: "/", active: false },
            { label: "Transactions", href: "/transactions", active: true },
            { label: "Checkout", href: "/checkout", active: false },
            { label: "Escrow", href: "/escrow", active: false },
            { label: "Support", href: "/support", active: false },
          ].map((item) => (
            <a key={item.label} href={item.href} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, textDecoration: "none", fontSize: 13, fontWeight: 500, background: item.active ? "rgba(13,124,95,0.18)" : "transparent", color: item.active ? "#0d7c5f" : "#6b7280", border: item.active ? "1px solid rgba(13,124,95,0.25)" : "1px solid transparent" }}>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, padding: "32px 32px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>Transactions</h1>
        <p style={{ color: "#64748b", fontSize: 13, marginBottom: 24 }}>All inbound agent settlement streams</p>

        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-base font-bold tracking-wide uppercase font-mono text-white">Inbound Agent Settlement Streams</h3>
            <span className="text-xs text-gray-500 font-mono bg-[#120b08] px-3 py-1 rounded-lg border border-[#3a2a20]">Prisma Database Synchronization</span>
          </div>

          {loading && <p className="text-gray-400 text-sm font-mono">Loading transactions...</p>}
          {error && <p className="text-red-400 text-xs font-mono">❌ {error}</p>}

          {!loading && payments.length === 0 && (
            <div className="text-center py-12">
              <p className="text-gray-500 text-sm font-mono">No transactions recorded yet.</p>
            </div>
          )}

          {!loading && payments.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-gray-500 uppercase tracking-wider border-b border-[#3a2a20]">
                    <th className="text-left pb-3 pr-4">Reference / Timestamp</th>
                    <th className="text-left pb-3 pr-4">Entity M2M Graph</th>
                    <th className="text-left pb-3 pr-4">Execution Domain</th>
                    <th className="text-left pb-3 pr-4">Payload Value</th>
                    <th className="text-left pb-3 pr-4">Status</th>
                    <th className="text-left pb-3">Circle CCTP Attestation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#3a2a20]/40">
                  {payments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-[#120b08]/40 transition-colors">
                      <td className="py-4 pr-4">
                        <div className="text-emerald-400">{payment.reference.slice(0, 16)}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">{new Date(payment.paid_at).toLocaleString()}</div>
                      </td>
                      <td className="py-4 pr-4">
                        <div className="text-gray-300">{payment.sender_email}</div>
                        <div className="text-gray-500 text-[10px] mt-0.5">→ Merchant: {payment.merchant}</div>
                      </td>
                      <td className="py-4 pr-4">
                        <span className="bg-emerald-400/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-400/20 text-[10px]">
                          {payment.chain.length > 20 ? "Arc-L1" : payment.chain}
                        </span>
                      </td>
                      <td className="py-4 pr-4">
                        <div className="text-white font-bold">{payment.amount.toFixed(2)}</div>
                        <div className="text-amber-400 text-[10px]">{payment.currency}</div>
                      </td>
                      <td className="py-4 pr-4">
                        <span className={`px-2 py-1 rounded text-[10px] font-bold border ${
                          payment.status === "SUCCESS" ? "bg-green-500/10 text-green-400 border-green-500/20"
                          : payment.status === "ATTESTATION_FAILED" ? "bg-red-500/10 text-red-400 border-red-500/20"
                          : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                        }`}>
                          {payment.status === "SUCCESS" ? "SUCCESS" : payment.status === "ATTESTATION_FAILED" ? "FAILED" : "PENDING"}
                        </span>
                      </td>
                      <td className="py-4">
                        <div className={`text-[10px] ${payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED" ? "text-green-400" : "text-amber-400"}`}>
                          {payment.cctp_telemetry.attestation_status === "REDEEMED_AND_MINTED" ? "REDEEMED_AND_MINTED" : "POLLING_CIRCLE_TESTNET_IRIS_API"}
                        </div>
                        <div className="text-gray-600 text-[10px] mt-0.5">Nonce: {payment.cctp_telemetry.nonce}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
