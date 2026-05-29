"use client";

import Link from "next/link";
import Image from "next/image";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[#120b08] text-white">
      {/* NAVBAR */}
      <nav className="border-b border-[#2a1d16]">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image
              src="/arcflare-logo.png"
              alt="ArcFlare"
              width={42}
              height={42}
            />
            <h1 className="text-2xl font-bold">
              ArcFlare
            </h1>
          </div>

          <div className="flex items-center gap-5">
            <Link
              href="/dashboard"
              className="text-sm text-gray-300 hover:text-white"
            >
              Dashboard
            </Link>

            <Link
              href="/checkout"
              className="text-sm text-gray-300 hover:text-white"
            >
              Checkout
            </Link>

            {/* Cyber-styled System Indicator replacing the old ConnectButton */}
            <div className="flex items-center gap-2 px-4 py-2 bg-[#1f140f] border border-[#3a2a22] rounded-xl text-xs font-mono text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.05)]">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              AGENT-CORE // ACTIVE
            </div>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="max-w-7xl mx-auto px-6 py-24 grid lg:grid-cols-2 gap-16 items-center">
        <div>
          <div className="inline-flex items-center gap-2 bg-[#1f140f] border border-[#3a2a22] rounded-full px-4 py-2 text-sm text-cyan-300 mb-8">
            Stablecoin Infrastructure on Arc
          </div>

          <h1 className="text-6xl font-bold leading-tight mb-8">
            Stablecoin Payment Infrastructure
            and Agentic Finance Layer on Arc
          </h1>

          <p className="text-xl text-gray-400 leading-relaxed mb-10">
            ArcFlare enables developers and merchants
            to accept programmable stablecoin payments
            through hosted checkout, wallet abstraction,
            automated settlement, and onchain payment APIs.
          </p>

          <div className="flex flex-wrap gap-5">
            <Link
              href="/dashboard"
              className="bg-cyan-400 text-black font-semibold px-8 py-4 rounded-2xl hover:scale-105 transition"
            >
              Launch Dashboard
            </Link>

            <Link
              href="/checkout"
              className="border border-[#3a2a22] px-8 py-4 rounded-2xl hover:bg-[#1d1410] transition"
            >
              View Checkout
            </Link>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="bg-[#1a120d] border border-[#2d2019] rounded-[32px] p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <div>
              <p className="text-gray-400 text-sm">
                Total Stablecoin Volume
              </p>
              <h2 className="text-5xl font-bold mt-2">
                $24.8K
              </h2>
            </div>
            <div className="bg-cyan-400/20 text-cyan-300 px-4 py-2 rounded-full text-sm">
              +18.2%
            </div>
          </div>

          <div className="space-y-5">
            <div className="bg-[#241913] rounded-2xl p-5 flex items-center justify-between">
              <div>
                <p className="font-semibold">
                  Merchant Checkout
                </p>
                <p className="text-sm text-gray-400">
                  Hosted USDC payments
                </p>
              </div>
              <p className="text-cyan-300">
                Active
              </p>
            </div>

            <div className="bg-[#241913] rounded-2xl p-5 flex items-center justify-between">
              <div>
                <p className="font-semibold">
                  Payment APIs
                </p>
                <p className="text-sm text-gray-400">
                  Initialize & Verify
                </p>
              </div>
              <p className="text-cyan-300">
                Online
              </p>
            </div>

            <div className="bg-[#241913] rounded-2xl p-5 flex items-center justify-between">
              <div>
                <p className="font-semibold">
                  Webhook Infrastructure
                </p>
                <p className="text-sm text-gray-400">
                  Real-time settlement events
                </p>
              </div>
              <p className="text-cyan-300">
                Running
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="max-w-7xl mx-auto px-6 pb-24">
        <div className="grid md:grid-cols-3 gap-8">
          <div className="bg-[#1a120d] border border-[#2d2019] rounded-3xl p-8">
            <h3 className="text-2xl font-bold mb-4">
              Hosted Checkout
            </h3>
            <p className="text-gray-400 leading-relaxed">
              Accept USDC payments through
              dynamic checkout pages with
              wallet-native UX.
            </p>
          </div>

          <div className="bg-[#1a120d] border border-[#2d2019] rounded-3xl p-8">
            <h3 className="text-2xl font-bold mb-4">
              Payment APIs
            </h3>
            <p className="text-gray-400 leading-relaxed">
              Initialize, verify, and automate
              programmable payment flows
              using ArcFlare APIs.
            </p>
          </div>

          <div className="bg-[#1a120d] border border-[#2d2019] rounded-3xl p-8">
            <h3 className="text-2xl font-bold mb-4">
              Agentic Finance
            </h3>
            <p className="text-gray-400 leading-relaxed">
              Build autonomous payment systems,
              programmable treasury flows,
              and intelligent settlement rails.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}