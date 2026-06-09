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
              src="/arcflare-logo.png.png"
              alt="ArcFlare"
              width={42}
              height={42}
            />
            <h1 className="text-2xl font-bold">ArcFlare</h1>
          </div>

          <div className="flex items-center gap-6">
            {/* Direct access to the Merchant Dashboard */}
            <Link
              href="/merchant/dashboard"
              className="text-sm text-gray-400 hover:text-cyan-300 transition"
            >
              Merchant Portal
            </Link>

            <Link
              href="/checkout"
              className="text-sm text-gray-400 hover:text-cyan-300 transition"
            >
              Demo Checkout
            </Link>

            {/* Login and Sign Up Links */}
            <div className="flex items-center gap-3 border-l border-[#3a2a22] pl-6">
              <Link
                href="/merchant/login"
                className="text-sm text-gray-300 hover:text-white transition"
              >
                Log in
              </Link>
              <Link
                href="/merchant/signup"
                className="text-sm bg-[#1f140f] border border-[#3a2a22] text-cyan-400 px-4 py-2 rounded-xl hover:bg-[#2a1d16] hover:border-cyan-400/50 transition shadow-[0_0_10px_rgba(34,211,238,0.02)]"
              >
                Sign Up
              </Link>
            </div>

            {/* Cyber-styled System Indicator */}
            <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-[#1f140f] border border-[#3a2a22] rounded-xl text-xs font-mono text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.05)] ml-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              AGENT-CORE // ACTIVE
            </div>
          </div>
        </div>
      </nav>

      {/* HERO SECTION - Updated the bottom button to match */}
      <section className="max-w-7xl mx-auto px-6 py-24 grid lg:grid-cols-2 gap-16 items-center">
        <div>
          <div className="inline-flex items-center gap-2 bg-[#1f140f] border border-[#3a2a22] rounded-full px-4 py-2 text-sm text-cyan-300 mb-8">
            Stablecoin Infrastructure on Arc
          </div>

          <h1 className="text-6xl font-bold leading-tight mb-8">
            Stablecoin Payment Infrastructure <br />
            and Agentic Finance Layer on Arc
          </h1>

          <p className="text-xl text-gray-400 leading-relaxed mb-10">
            ArcFlare enables developers and merchants
            to accept programmable stablecoin payments
            through hosted checkout, escrow services,
            automated settlement, and onchain payment APIs.
          </p>

          <div className="flex flex-wrap gap-5">
            <Link
              href="/merchant/signup"
              className="bg-cyan-400 text-black font-semibold px-8 py-4 rounded-2xl hover:scale-105 transition shadow-[0_0_20px_rgba(34,211,238,0.2)]"
            >
              Start Accepting Payments
            </Link>

            <Link
              href="/merchant/dashboard"
              className="border border-[#3a2a22] bg-[#1a120d] px-8 py-4 rounded-2xl hover:bg-[#241913] hover:border-[#4a362a] transition"
            >
              Merchant Portal
            </Link>
          </div>
        </div>

        {/* ... rest of your existing Right Panel and Features remain unchanged ... */}
      </section>
      
      {/* (Rest of your original homepage code goes here) */}
    </main>
  );
}