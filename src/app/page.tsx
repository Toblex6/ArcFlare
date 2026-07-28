// src/app/page.tsx
'use client';
import ThemeToggle from '@/src/components/ThemeToggle';
import Link from 'next/link';
import Image from 'next/image';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--text)]">
      {/* NAVBAR */}
      <nav className="border-b border-[var(--border)]">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={42} height={42} />
            <h1 className="text-2xl font-bold">FlareHQ</h1>
          </div>

          <div className="flex items-center gap-6">
            <ThemeToggle />
            <Link href="/docs" className="text-sm text-[var(--text-secondary)] hover:text-cyan-300 transition">
              Docs
            </Link>

            <div className="flex items-center gap-3 border-l border-[var(--border)] pl-6">
              <Link
                href="/merchant/login"
                className="text-sm text-[var(--text-secondary)] hover:text-[var(--text)] transition"
              >
                Business Login
              </Link>
              <Link
                href="/start"
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
          <div className="inline-flex items-center gap-2 bg-[var(--surface-secondary)] border border-[var(--border)] rounded-full px-4 py-2 text-sm text-cyan-300 mb-8">
            ● Live on Arc Testnet
          </div>

          <h1 className="text-6xl font-bold leading-tight mb-8">
            Stablecoin Payments and Agentic Finance on Arc
          </h1>

          <p className="text-xl text-[var(--text-secondary)] leading-relaxed mb-10">
            FlareHQ lets merchants accept USDC payments through hosted checkout links, and enables
            AI agents to transact autonomously — with streaming payments, escrow, and micro-billing
            built in.
          </p>

          <div className="flex flex-wrap gap-5">
            <Link
              href="/start"
              className="bg-cyan-400 text-black font-semibold px-8 py-4 rounded-2xl hover:scale-105 transition shadow-[0_0_20px_rgba(34,211,238,0.2)]"
            >
              Get Started →
            </Link>
            <Link
              href="/docs"
              className="border border-[var(--border)] bg-[var(--surface)] px-8 py-4 rounded-2xl hover:bg-[var(--surface-secondary)] transition"
            >
              Read the Docs
            </Link>
          </div>
        </div>

        {/* RIGHT PANEL — live stats */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[32px] p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <div>
              <p className="text-[var(--text-secondary)] text-sm">Arc Testnet — Live</p>
              <h2 className="text-5xl font-bold mt-2">USDC</h2>
            </div>
            <div className="bg-cyan-400/20 text-cyan-300 px-4 py-2 rounded-full text-sm font-mono">
              ● ACTIVE
            </div>
          </div>

          <div className="space-y-4">
            {[
              {
                title: 'Hosted Checkout',
                desc: 'Shareable payment links for any amount',
                status: 'Live',
              },
              {
                title: 'Payment Streaming',
                desc: 'USDC drips per second to receivers',
                status: 'Live',
              },
              { title: 'Escrow', desc: 'Trustless USDC escrow via smart contract', status: 'Live' },
              {
                title: 'Agent M2M Payments',
                desc: 'Autonomous micro-billing between AI agents',
                status: 'Live',
              },
            ].map((item, i) => (
              <div
                key={i}
                className="bg-[var(--surface-secondary)] rounded-2xl p-4 flex items-center justify-between"
              >
                <div>
                  <p className="font-semibold text-sm">{item.title}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">{item.desc}</p>
                </div>
                <p className="text-cyan-300 text-sm font-mono">{item.status}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="max-w-7xl mx-auto px-6 pb-16">
        <h2 className="text-3xl font-bold mb-12 text-center">
          For merchants. For agents. For developers.
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {[
            {
              icon: '🏪',
              title: 'Merchants',
              desc: 'Sign up, get an API key, and generate payment links in seconds. Customers pay in USDC — you receive it on Arc.',
              cta: 'Create account',
              href: '/merchant/signup',
            },
            {
              icon: '👤',
              title: 'Individuals',
              desc: 'Send money, request payments, and save automatically — just connect or create a wallet, no signup form.',
              cta: 'Get started',
              href: '/consumer',
            },
            {
              icon: '🤖',
              title: 'AI Agents',
              desc: 'Deploy ERC-8004 identity wallets and pay other agents per API call, per second, or per task — fully autonomous.',
              cta: 'View API docs',
              href: '/docs/agents',
            },
            {
              icon: '⚡',
              title: 'Developers',
              desc: 'Integrate FlareHQ APIs into your app. Initialize payments, verify settlements, stream USDC, and set up webhooks.',
              cta: 'Read the docs',
              href: '/docs',
            },
          ].map((card, i) => (
            <div
              key={i}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-8 flex flex-col hover:border-cyan-900/50 transition duration-300"
            >
              <div className="text-4xl mb-4">{card.icon}</div>
              <h3 className="text-xl font-bold mb-3">{card.title}</h3>
              <p className="text-[var(--text-secondary)] leading-relaxed flex-1">{card.desc}</p>
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
      <footer className="border-t border-[var(--border)] py-10">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={28} height={28} />
            <span className="text-[var(--text-secondary)] text-sm">FlareHQ — Built on Arc Testnet</span>
          </div>
          <div className="flex gap-6 text-sm text-[var(--text-secondary)]">
            <Link href="/merchant/signup" className="hover:text-[var(--text)] transition">
              Sign Up
            </Link>
            <Link href="/merchant/login" className="hover:text-[var(--text)] transition">
              Login
            </Link>
            <Link href="/consumer" className="hover:text-[var(--text)] transition">
              Personal
            </Link>
            <Link href="/docs" className="hover:text-[var(--text)] transition">
              Docs
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}