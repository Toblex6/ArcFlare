"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

export default function CheckoutHubPage() {
  const router = useRouter();
  const [isInitializing, setIsInitializing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleLaunchTestnetSession = async () => {
    setIsInitializing(true);
    setError(null);

    try {
      // 1. Send the initialization payload with fields aligned to backend expectations
      const res = await fetch("/api/payments/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: 0.1,
          currency: "USDC",
          email: "public-tester-agent@autonomous.bot.network", // Aligned name
          merchant: "Dispatch Marketplace",
        }),
      });

      const result = await res.json();
      
      console.log("=== ARCFLARE DEBUG DATA ===", result);

      // 2. Extract reference token variations
      const reference = result.reference || result.data?.reference || result.token || result.data?.token;

      if (reference) {
        // 3. Forward into your dynamic checkout matrix
        router.push(`/checkout/${reference}`);
      } else {
        setError(result.message || result.error || "Ledger rejected context token generation.");
      }
    } catch (err) {
      console.error("API Connection Error:", err);
      setError("Unable to initialize connection with ArcFlare Gateway.");
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#120b08] text-white flex flex-col justify-between px-6 py-12">
      
      {/* HEADER BRANDING */}
      <div className="max-w-4xl w-full mx-auto flex items-center gap-4 mb-8">
        <Image
          src="/arcflare-logo.png"
          alt="ArcFlare Logo"
          width={50}
          height={50}
          className="object-contain"
        />
        <div>
          <h1 className="text-2xl font-bold tracking-wide">ArcFlare</h1>
          <p className="text-cyan-300 text-xs uppercase tracking-widest">Sandbox Environment</p>
        </div>
      </div>

      {/* CORE HUB INTERFACE */}
      <div className="max-w-xl w-full mx-auto bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-8 shadow-2xl my-auto">
        <div className="text-center mb-8">
          <span className="bg-cyan-400/10 text-cyan-300 font-mono text-xs px-3 py-1 rounded-full border border-cyan-400/20">
            Arc Testnet v1.0
          </span>
          <h2 className="text-3xl font-bold mt-4 mb-2">Developer Playbox</h2>
          <p className="text-gray-400 text-sm leading-relaxed">
            Generate autonomous machine purchase instances on the Arc Network ledger layer. 
            No manual code entry required.
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 mb-6 text-center">
            <p className="text-red-400 text-sm font-medium">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          <div className="bg-[#2a1c15] border border-[#493328] rounded-2xl p-4 flex justify-between items-center text-sm">
            <span className="text-gray-400">Mock Item</span>
            <span className="font-semibold text-gray-200">Dispatch Node License</span>
          </div>
          <div className="bg-[#2a1c15] border border-[#493328] rounded-2xl p-4 flex justify-between items-center text-sm">
            <span className="text-gray-400">Gas Asset strategy</span>
            <span className="font-mono text-cyan-300 font-bold">USDC-Native Rails</span>
          </div>
        </div>

        <button
          onClick={handleLaunchTestnetSession}
          disabled={isInitializing}
          className="w-full mt-8 bg-cyan-400 hover:bg-cyan-300 disabled:bg-cyan-800 disabled:text-gray-500 text-black font-bold py-4 rounded-2xl text-lg transition-all shadow-lg shadow-cyan-400/5 active:scale-[0.99]"
        >
          {isInitializing ? "Minting Ledger Token..." : "Launch Live Testnet Checkout"}
        </button>
      </div>

      {/* FOOTER */}
      <div className="max-w-4xl w-full mx-auto text-center mt-8 text-xs text-gray-500">
        <p>ArcFlare Payment Infrastructure Node • Configured for Cross-Chain Circle CCTP Simulations</p>
      </div>
    </main>
  );
}