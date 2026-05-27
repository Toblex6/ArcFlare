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
  cctp_telemetry?: {
    source_domain: number;
    target_domain: number;
    attestation_status: string;
    nonce: number;
  };
}

export default function MerchantDashboard() {
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const seedDashboardData = async () => {
      try {
        setPayments([
          {
            id: "1",
            reference: "T8821491779843759632",
            amount: 0.10,
            currency: "USDC",
            chain: "Arbitrum Sepolia ➔ Arc Testnet (via Circle CCTP)",
            status: "SUCCESS",
            sender_email: "agent-alpha-0x99@autonomous.bot.network",
            merchant: "Dispatch Marketplace",
            paid_at: new Date(Date.now() - 500000).toISOString(),
            cctp_telemetry: { source_domain: 3, target_domain: 7, attestation_status: "REDEEMED_AND_MINTED", nonce: 482910 }
          },
          {
            id: "2",
            reference: "T5323281779843303243",
            amount: 0.10,
            currency: "USDC",
            chain: "Arbitrum Sepolia ➔ Arc Testnet (via Circle CCTP)",
            status: "PENDING",
            sender_email: "autonomous-machine-02@bot.network",
            merchant: "Dispatch Marketplace",
            paid_at: new Date().toISOString(),
            cctp_telemetry: { source_domain: 3, target_domain: 7, attestation_status: "POLLING_CIRCLE_TESTNET_IRIS_API", nonce: 994012 }
          }
        ]);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    seedDashboardData();
  }, []);

  const totalVolume = payments.reduce((acc, curr) => curr.status === "SUCCESS" ? acc + curr.amount : acc, 0);
  const successRate = (payments.filter(p => p.status === "SUCCESS").length / payments.length) * 100;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#120b08] text-white flex items-center justify-center">
        <p className="text-amber-400 animate-pulse tracking-widest text-sm font-mono">SYNCING TESTNET TELEMETRY INSTANCE...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10 font-sans">
      
      <div className="max-w-6xl mx-auto mb-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-center">
        <p className="text-xs text-amber-400 font-mono tracking-wide uppercase">
          ⚠️ ArcFlare Ecosystem Monitoring Node — Running on <span className="underline font-bold">Arc Testnet Mode</span>. All assets shown represent simulated test faucet settlements.
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
          <span className="text-xs bg-amber-400/10 text-amber-300 px-3 py-1.5 border border-amber-400/20 rounded-full font-mono uppercase tracking-wider">
            ● Testnet Node Active
          </span>
        </div>

        <div className="grid md:grid-cols-3 gap-6 mb-10">
          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Testnet Volume Settled</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">{totalVolume.toFixed(2)} <span className="text-sm font-medium text-amber-400">tUSDC</span></h2>
          </div>

          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Active Infrastructure Nodes</p>
            <h2 className="text-3xl font-extrabold text-white font-mono">2 <span className="text-xs font-normal text-gray-500">M2M Channels</span></h2>
          </div>

          <div className="bg-[#1f140f] border border-[#3a2a20] p-6 rounded-2xl shadow-xl">
            <div className="flex justify-between items-center mb-2">
              <p className="text-gray-400 text-xs uppercase tracking-wider">CCTP Testnet Attestation Precision</p>
              <span className="text-cyan-300 font-bold text-sm font-mono">{successRate.toFixed(1)}%</span>
            </div>
            <div className="w-full h-2.5 bg-[#120b08] rounded-full overflow-hidden mt-3">
              <div className="h-full bg-amber-400 rounded-full" style={{ width: `${successRate}%` }}></div>
            </div>
          </div>
        </div>

        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-6 shadow-2xl overflow-hidden">
          <h3 className="text-lg font-bold mb-6 tracking-wide">Live Testnet Stream</h3>
          
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
        </div>
      </div>
    </main>
  );
}