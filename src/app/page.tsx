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
            <Image src="/arcflare-logo.png.png" alt="ArcFlare" width={42} height={42} />
            <h1 className="text-2xl font-bold">ArcFlare</h1>
          </div>

          <div className="flex items-center gap-6">
            <Link href="/checkout" className="text-sm text-gray-400 hover:text-cyan-300 transition">
              Demo Checkout
            </Link>
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-cyan-300 transition">
              Admin
            </Link>

            <div className="flex items-center gap-3 border-l border-[#3a2a22] pl-6">
              <Link href="/merchant/login" className="text-sm text-gray-300 hover:text-white transition">
                Log in
              </Link>
              <Link
                href="/merchant/signup"
                className="text-sm bg-cyan-400 text-black font-semibold px-4 py-2 rounded-xl hover:bg-cyan-300 transition"
              >
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="max-w-7xl mx-auto px-6 py-24 grid lg:grid-cols-2 gap-16 items-center">
        <div>
          <div className="inline-flex items-center gap-2 bg-[#1f140f] border border-[#3a2a22] rounded-full px-4 py-2 text-sm text-cyan-300 mb-8">
            ● Live on Arc Testnet
          </div>

          <h1 className="text-6xl font-bold leading-tight mb-8">
            Stablecoin Payments and Agentic Finance on Arc
          </h1>

          <p className="text-xl text-gray-400 leading-relaxed mb-10">
            ArcFlare lets merchants accept USDC payments through hosted checkout links,
            and enables AI agents to transact autonomously — with streaming payments,
            escrow, and micro-billing built in.
          </p>

          <div className="flex flex-wrap gap-5">
            <Link
              href="/merchant/signup"
              className="bg-cyan-400 text-black font-semibold px-8 py-4 rounded-2xl hover:scale-105 transition shadow-[0_0_20px_rgba(34,211,238,0.2)]"
            >
              Start Accepting Payments →
            </Link>
            <Link
              href="/checkout"
              className="border border-[#3a2a22] bg-[#1a120d] px-8 py-4 rounded-2xl hover:bg-[#241913] transition"
            >
              Try Demo Checkout
            </Link>
          </div>
        </div>

        {/* RIGHT PANEL — live stats */}
        <div className="bg-[#1a120d] border border-[#2d2019] rounded-[32px] p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <div>
              <p className="text-gray-400 text-sm">Arc Testnet — Live</p>
              <h2 className="text-5xl font-bold mt-2">USDC</h2>
            </div>
            <div className="bg-cyan-400/20 text-cyan-300 px-4 py-2 rounded-full text-sm font-mono">
              ● ACTIVE
            </div>
          </div>

          <div className="space-y-4">
            {[
              { title: "Hosted Checkout", desc: "Shareable payment links for any amount", status: "Live" },
              { title: "Payment Streaming", desc: "USDC drips per second to receivers", status: "Live" },
              { title: "Escrow", desc: "Trustless USDC escrow via smart contract", status: "Live" },
              { title: "Agent M2M Payments", desc: "Autonomous micro-billing between AI agents", status: "Live" },
            ].map((item, i) => (
              <div key={i} className="bg-[#241913] rounded-2xl p-4 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-sm">{item.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                </div>
                <p className="text-cyan-300 text-sm font-mono">{item.status}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="max-w-7xl mx-auto px-6 pb-16">
        <h2 className="text-3xl font-bold mb-12 text-center">For merchants. For agents. For developers.</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              icon: "🏪",
              title: "Merchants",
              desc: "Sign up, get an API key, and generate payment links in seconds. Customers pay in USDC — you receive it on Arc.",
              cta: "Create account",
              href: "/merchant/signup",
            },
            {
              icon: "🤖",
              title: "AI Agents",
              desc: "Deploy ERC-8004 identity wallets and pay other agents per API call, per second, or per task — fully autonomous.",
              cta: "View API docs",
              href: "/docs/api/page.tsx",
            },
            {
              icon: "⚡",
              title: "Developers",
              desc: "Integrate ArcFlare APIs into your app. Initialize payments, verify settlements, stream USDC, and set up webhooks.",
              cta: "Read the docs",
              href: "/docs/page.tsx",
            },
          ].map((card, i) => (
            <div key={i} className="bg-[#1a120d] border border-[#2d2019] rounded-3xl p-8 flex flex-col hover:border-cyan-900/50 transition duration-300">
              <div className="text-4xl mb-4">{card.icon}</div>
              <h3 className="text-xl font-bold mb-3">{card.title}</h3>
              <p className="text-gray-400 leading-relaxed flex-1">{card.desc}</p>
              <Link
                href={card.href}
                className="mt-6 text-cyan-400 text-sm font-semibold hover:text-cyan-300 transition"
              >
                {card.cta} →
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-[#2a1d16] py-10">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/arcflare-logo.png.png" alt="ArcFlare" width={28} height={28} />
            <span className="text-gray-500 text-sm">ArcFlare — Built on Arc Testnet</span>
          </div>
          <div className="flex gap-6 text-sm text-gray-500">
            <Link href="/merchant/signup" className="hover:text-white transition">Sign Up</Link>
            <Link href="/merchant/login" className="hover:text-white transition">Login</Link>
            <Link href="/checkout" className="hover:text-white transition">Demo</Link>
            <Link href="/dashboard" className="hover:text-white transition">Admin</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
