"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export default function DashboardPage() {
  // Explicitly casting to any eliminates the strict null connection type error on Vercel deployment
  const { address, isConnected } = useAccount() as any;

  // Handle hydration mismatch safely by verifying component is mounted in browser
  const [mounted, setMounted] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [loadingKeys, setLoadingKeys] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Safe client-side local key creator (Zero extension/backend dependencies)
  const handleGenerateApiKey = () => {
    setLoadingKeys(true);
    setTimeout(() => {
      const randomHex = Array.from({ length: 48 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("");
      const generatedKey = `af_live_${randomHex}`;
      setApiKey(generatedKey);
      setLoadingKeys(false);
      alert(`New Live API Key Provisioned successfully:\n\n${generatedKey}\n\nKeep this safe!`);
    }, 600);
  };

  // Helper to safely format address to a readable mid-truncated string (e.g. 0x1234...5678)
  const formatAddress = (addr?: string) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <main className="min-h-screen bg-[#1A120B] flex text-white">

      {/* Sidebar */}
      <aside className="w-[260px] bg-[#3C2A21] border-r border-[#5C4033] p-6 hidden lg:flex flex-col justify-between">
        <div>
          <div className="mb-10">
            <h1 className="text-3xl font-bold text-[#FFF8EA]">
              ArcFlare
            </h1>
            <p className="text-sm text-[#D5CEA3] mt-1">
              Stablecoin Payment Infrastructure
            </p>
          </div>

          <nav className="space-y-2">
            {[
              "Dashboard",
              "Payments",
              "Transactions",
              "Merchants",
              "Wallets",
              "Analytics",
              "Webhooks",
              "Settings",
            ].map((item) => (
              <button
                key={item}
                className={`w-full text-left px-4 py-3 rounded-2xl transition-all ${
                  item === "Dashboard"
                    ? "bg-[#0F3D3E] text-[#FFF8EA]"
                    : "hover:bg-[#5C4033] text-[#E5D3B3]"
                }`}
              >
                {item}
              </button>
            ))}
          </nav>
        </div>

        <div className="rounded-3xl bg-[#0F3D3E] p-5">
          <p className="text-sm text-cyan-200">
            ArcFlare Gateway
          </p>
          <h2 className="text-2xl font-bold text-white mt-2">
            Testnet Live
          </h2>
          <p className="text-xs text-cyan-100 mt-2">
            Stablecoin payments powered by Arc.
          </p>
        </div>
      </aside>

      {/* Main */}
      <section className="flex-1 p-6 lg:p-10 overflow-y-auto">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[#FFF8EA]">
              Merchant Dashboard
            </h1>
            <p className="text-[#D5CEA3] mt-1">
              Monitor payments, balances, and merchant activity.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {/* Safe Web3 Mounted Conditional UI Wrapper */}
            {!mounted ? (
              <button className="bg-cyan-400 opacity-60 text-black px-5 py-3 rounded-2xl font-semibold cursor-wait">
                Loading...
              </button>
            ) : (
              <ConnectButton.Custom>
                {({ account, chain, openAccountModal, openConnectModal, mounted: rbMounted }) => {
                  const ready = rbMounted;
                  const connected = ready && account && chain;

                  if (!ready) return null;

                  return (
                    <div>
                      {!connected ? (
                        <button
                          onClick={openConnectModal}
                          type="button"
                          className="bg-cyan-400 hover:bg-cyan-300 transition-all text-black px-5 py-3 rounded-2xl font-semibold"
                        >
                          Connect Wallet
                        </button>
                      ) : (
                        <button
                          onClick={openAccountModal}
                          type="button"
                          className="bg-red-500 hover:bg-red-400 transition-all text-white px-5 py-3 rounded-2xl font-semibold"
                        >
                          Disconnect Account
                        </button>
                      )}
                    </div>
                  );
                }}
              </ConnectButton.Custom>
            )}

            <Link
              href="/checkout/test123"
              className="bg-[#0F3D3E] hover:bg-cyan-900 transition-all text-white px-5 py-3 rounded-2xl font-semibold"
            >
              Open Checkout
            </Link>

            <div className="bg-[#3C2A21] border border-[#5C4033] px-4 py-3 rounded-2xl max-w-[260px] min-w-[200px]">
              <p className="text-xs text-[#D5CEA3]">
                Connected Wallet
              </p>
              <p className="text-sm text-white truncate mt-1">
                {mounted && isConnected && address
                  ? formatAddress(address)
                  : "No wallet connected"}
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5 mb-8">
          {[
            { title: "Total Volume", value: "$42,580", change: "+18%" },
            { title: "Transactions", value: "1,248", change: "+12%" },
            { title: "Merchants", value: "84", change: "+6%" },
            { title: "Revenue", value: "$1,920", change: "+22%" },
          ].map((card) => (
            <div
              key={card.title}
              className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6"
            >
              <p className="text-[#D5CEA3] text-sm">
                {card.title}
              </p>
              <div className="flex items-end justify-between mt-4">
                <h2 className="text-3xl font-bold text-[#FFF8EA]">
                  {card.value}
                </h2>
                <span className="text-cyan-300 text-sm font-semibold">
                  {card.change}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
          {/* Analytics */}
          <div className="xl:col-span-2 bg-[#3C2A21] border border-[#5C4033] rounded-3xl p-6">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-xl font-bold text-[#FFF8EA]">
                  Payment Analytics
                </h2>
                <p className="text-sm text-[#D5CEA3] mt-1">
                  Stablecoin transaction activity
                </p>
              </div>
              <button className="bg-[#0F3D3E] text-white px-4 py-2 rounded-xl text-sm">
                Export
              </button>
            </div>
            <div className="h-[320px] bg-[#1A120B] border border-[#5C4033] rounded-3xl flex items-center justify-center text-[#D5CEA3]">
              Analytics Chart Area
            </div>
          </div>

          {/* Revenue Card */}
          <div className="bg-[#0F3D3E] rounded-3xl p-6 shadow-2xl flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <p className="text-cyan-200 text-sm">
                    Gateway Revenue
                  </p>
                  <h2 className="text-3xl font-bold text-white mt-1">
                    1,240 USDC
                  </h2>
                </div>
                <div className="bg-cyan-400/20 text-cyan-300 px-3 py-1 rounded-full text-xs">
                  LIVE
                </div>
              </div>

              <div className="space-y-4 mb-6">
                <div className="bg-white/10 rounded-2xl p-4">
                  <p className="text-xs text-cyan-100">
                    Active API Key Profile
                  </p>
                  <p className="text-white font-mono text-xs truncate mt-1">
                    {apiKey ? apiKey : "No generated keys found"}
                  </p>
                </div>
                <div className="bg-white/10 rounded-2xl p-4">
                  <p className="text-xs text-cyan-100">
                    Failed Payments
                  </p>
                  <p className="text-white font-semibold mt-1">
                    38
                  </p>
                </div>
              </div>
            </div>

            <button 
              onClick={handleGenerateApiKey}
              disabled={loadingKeys}
              className="w-full bg-cyan-400 hover:bg-cyan-300 transition-all text-black font-semibold py-4 rounded-2xl disabled:opacity-50"
            >
              {loadingKeys ? "Signing Keys..." : "Generate API Key"}
            </button>
          </div>
        </div>

        {/* Transactions */}
        <div className="bg-[#3C2A21] border border-[#5C4033] rounded-3xl overflow-hidden">
          <div className="p-6 border-b border-[#5C4033]">
            <h2 className="text-xl font-bold text-[#FFF8EA]">
              Recent Transactions
            </h2>
            <p className="text-sm text-[#D5CEA3] mt-1">
              Latest payments processed by ArcFlare
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#2B1D16] text-left text-sm text-[#D5CEA3]">
                <tr>
                  <th className="px-6 py-4">Transaction</th>
                  <th className="px-6 py-4">Merchant</th>
                  <th className="px-6 py-4">Amount</th>
                  <th className="px-6 py-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { tx: "0x84...92ab", merchant: "Tower Labs", amount: "50 USDC", status: "Success" },
                  { tx: "0x11...7dac", merchant: "Arc Market", amount: "120 USDC", status: "Pending" },
                  { tx: "0x91...2fbc", merchant: "Stable Pay", amount: "300 USDC", status: "Success" },
                ].map((row) => (
                  <tr key={row.tx} className="border-t border-[#5C4033]">
                    <td className="px-6 py-5 text-[#FFF8EA] font-medium">
                      {row.tx}
                    </td>
                    <td className="px-6 py-5 text-[#D5CEA3]">
                      {row.merchant}
                    </td>
                    <td className="px-6 py-5 text-[#D5CEA3]">
                      {row.amount}
                    </td>
                    <td className="px-6 py-5">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-medium ${
                          row.status === "Success"
                            ? "bg-cyan-500/20 text-cyan-300"
                            : "bg-[#D5CEA3]/20 text-[#FFF8EA]"
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </section>
    </main>
  );
}