"use client";

import React, { useEffect, useState } from "react";
import Image from "next/image";

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

export default function MerchantDashboard() {
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>({ totalVolume: 0, successRate: 100, totalTransactions: 0 });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLiveDatabaseState = async (isSilentUpdate = false) => {
    try {
      const res = await fetch("/api/payments/all");
      const json = await res.json();

      if (json.status) {
        setPayments(json.data);
        setMetrics(json.metrics);
        setError(null);
      } else {
        throw new Error(json.error || "Mismatched routing payload configuration.");
      }
    } catch (err: any) {
      console.error("Telemetry Retrieval Error:", err);
      if (!isSilentUpdate) setError("Failed to synchronize dashboard metrics with cloud engine.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Initial loading execution sequence
    fetchLiveDatabaseState();

    // Configure a 5-second automatic data polling background routine
    const interval = setInterval(() => {
      fetchLiveDatabaseState(true);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#120b08] text-white flex items-center justify-center">
        <p className="text-amber-400 animate-pulse tracking-widest text-sm font-mono uppercase">SYNCING TESTNET TELEMETRY INSTANCE...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10 font-sans">
      <div className="max-w-6xl mx-auto mb-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-center">
        <p className="text-xs text-amber-400 font-mono tracking-wide uppercase">
          ⚠️ ArcFlare Ecosystem Monitoring Node — Running on <span className="underline font-bold">Arc Testnet Mode</span>. Connected to Live Cloud Ledger.
        </p>
      </div>

      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between border-b border-[#3a2a20] pb-6 mb-10">
          <div className="flex items-center gap-4">
            <Image src="/arcflare-logo.png" alt="ArcFlare Logo" width={50} height={50} className="object-contain" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">ArcFlare Merchant Terminal</h1>
              <p className="text-xs text-gray-400">Agentic Commerce & Stablecoin Ledger Telemetry</p>
            </div>
          </div>
          <span className="text-xs bg-amber-400/10 text-amber-300 px-3 py-1.5 border border-amber-400/20 rounded-full font-mono uppercase tracking-wider animate-pulse">
            ● Live Network Node Active
          </span>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400 font-mono">
            Error: {error}
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6 mb-10">
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Testnet Volume Settled</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">
              {metrics.totalVolume.toFixed(2)} <span className="text-sm font-medium text-amber-400">tUSDC</span>
            </h2>
          </div>

          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Total M2M Operations</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">
              {metrics.totalTransactions} <span className="text-xs font-normal text-gray-500">Recorded Tx</span>
            </h2>
          </div>

          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <div className="flex justify-between items-center mb-2">
              <p className="text-gray-400 text-xs uppercase tracking-wider">CCTP Attestation Precision</p>
              <span className="text-cyan-300 font-bold text-sm font-mono">{metrics.successRate.toFixed(1)}%</span>
            </div>
            <div className="w-full h-2.5 bg-[#120b08] rounded-full overflow-hidden mt-3">
              <div className="h-full bg-amber-400 transition-all duration-500" style={{ width: `${metrics.successRate}%` }}></div>
            </div>
          </div>
        </div>

        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl overflow-hidden">
          <h3 className="text-lg font-bold mb-6 tracking-wide">Live Database Transaction Stream</h3>
          
          {payments.length === 0 ? (
            <p className="text-gray-500 text-center py-8 font-mono text-sm">No transaction events captured on the current database slice yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#3a2a20] text-gray-400 text-xs uppercase tracking-wider">
                    <th className="py-4 px-4">Tracking ID</th>
                    <th className="py-4 px-4">Payer Entity</th>
                    <th className="py-4 px-4">Settlement Bridge Layer</th>
                    <th className="py-4 px-4 text-right">Gross Amount</th>
                    <th className="py-4 px-4 text-center">CCTP Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#3a2a20]/40 text-sm font-mono">
                  {payments.map((item) => (
                    <tr key={item.id} className="hover:bg-[#2a1c15]/30 transition-all">
                      <td className="py-4 px-4 font-mono text-amber-400 text-xs select-all">{item.reference}</td>
                      <td className="py-4 px-4 text-gray-300 text-xs truncate max-w-[150px]">{item.sender_email}</td>
                      <td className="py-4 px-4 text-gray-400 text-xs">{item.chain}</td>
                      <td className="py-4 px-4 text-right font-bold text-white">
                        {item.amount} <span className="text-xs font-normal text-amber-400">{item.currency}</span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className={`inline-block text-[10px] uppercase font-bold px-2.5 py-1 rounded-md tracking-wider ${
                          item.status === "SUCCESS" 
                            ? "bg-green-500/10 text-green-400 border border-green-500/20" 
                            : "bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse"
                        }`}>
                          {item.cctp_telemetry?.attestation_status.replace(/_/g, " ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}