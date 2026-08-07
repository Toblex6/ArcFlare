// src/app/page.tsx
'use client';
import { useState } from 'react';
import ThemeToggle from '@/src/components/ThemeToggle';
import Link from 'next/link';
import Image from 'next/image';

export default function HomePage() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--text)] overflow-x-hidden">
      {/* NAVBAR */}
      <nav className="border-b border-[var(--border)] relative z-50 bg-[var(--background)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">

          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={40} height={40} className="w-8 h-8 sm:w-[42px] sm:h-[42px]" />
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">FlareHQ</h1>
          </div>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-6">
            <ThemeToggle />
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[var(--text-secondary)] hover:text-cyan-300 transition whitespace-nowrap"
            >
              Docs ↗
            </a>

            <div className="flex items-center gap-4 border-l border-[var(--border)] pl-6">
              <Link
                href="/merchant/login"
                className="text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text)] transition whitespace-nowrap"
              >
                Business Login
              </Link>
              <Link
                href="/start"
                className="text-sm bg-cyan-400 text-black font-bold px-5 py-2.5 rounded-xl hover:bg-cyan-300 transition whitespace-nowrap"
              >
                Get Started
              </Link>
            </div>
          </div>

          {/* Mobile Nav Toggle */}
          <div className="flex md:hidden items-center gap-4 shrink-0">
            <ThemeToggle />
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label="Toggle navigation menu"
              className="p-2 text-[var(--text-secondary)] hover:text-[var(--text)] transition"
            >
              {isMobileMenuOpen ? (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Mobile Menu Dropdown */}
        {isMobileMenuOpen && (
          <div className="md:hidden border-t border-[var(--border)] bg-[var(--background)] px-4 py-4 flex flex-col gap-4 absolute w-full left-0 shadow-lg z-40">
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-medium text-[var(--text-secondary)] hover:text-[var(--text)] transition p-2"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              Docs ↗
            </a>
            <Link
              href="/merchant/login"
              className="text-base font-medium text-[var(--text-secondary)] hover:text-[var(--text)] transition p-2"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              Business Login
            </Link>
            <Link
              href="/start"
              className="text-base text-center bg-cyan-400 text-black font-bold px-5 py-3.5 rounded-xl hover:bg-cyan-300 transition w-full whitespace-nowrap mt-2"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              Get Started
            </Link>
          </div>
        )}
      </nav>

      {/* HERO */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <div>
          <div className="inline-flex items-center gap-2 bg-[var(--surface-secondary)] border border-[var(--border)] rounded-full px-4 py-2 text-xs sm:text-sm text-cyan-300 mb-6 sm:mb-8 whitespace-nowrap">
            ● Live on Arc Testnet
          </div>

          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight md:leading-[1.1] mb-6 sm:mb-8">
            Stablecoin Payments and Agentic Finance on Arc
          </h1>

          <p className="text-lg md:text-xl text-[var(--text-secondary)] leading-relaxed mb-8 sm:mb-10">
            FlareHQ lets merchants accept USDC payments through hosted checkout links, and enables
            AI agents to transact autonomously — with streaming payments, escrow, and micro-billing
            built in.
          </p>

          <div className="flex flex-col sm:flex-row flex-wrap gap-4 sm:gap-5">
            <Link
              href="/start"
              className="bg-cyan-400 text-black font-bold px-8 py-4 rounded-2xl hover:scale-105 transition shadow-[0_0_20px_rgba(34,211,238,0.2)] text-center w-full sm:w-auto whitespace-nowrap"
            >
              Get Started →
            </Link>
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-[var(--border)] bg-[var(--surface)] font-medium px-8 py-4 rounded-2xl hover:bg-[var(--surface-secondary)] transition inline-flex items-center justify-center gap-2 text-center w-full sm:w-auto whitespace-nowrap"
            >
              Read the Docs ↗
            </a>
          </div>
        </div>

        {/* RIGHT PANEL — live stats */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[24px] md:rounded-[32px] p-6 sm:p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
            <div>
              <p className="text-[var(--text-secondary)] text-sm whitespace-nowrap">Arc Testnet — Live</p>
              <h2 className="text-4xl sm:text-5xl font-bold mt-2">USDC</h2>
            </div>
            <div className="bg-cyan-400/20 text-cyan-300 px-4 py-2 rounded-full text-xs sm:text-sm font-mono whitespace-nowrap shrink-0">
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
                className="bg-[var(--surface-secondary)] rounded-2xl p-4 flex sm:items-center flex-col sm:flex-row justify-between gap-3 sm:gap-4"
              >
                <div>
                  <p className="font-semibold text-sm">{item.title}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">{item.desc}</p>
                </div>
                <p className="text-cyan-300 text-sm font-mono whitespace-nowrap self-start sm:self-auto">{item.status}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-16 md:pb-24">
        <h2 className="text-2xl md:text-3xl font-bold mb-10 md:mb-12 text-center">
          For merchants. For agents. For developers.
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
          {[
            {
              icon: '🏪',
              title: 'Merchants',
              desc: 'Sign up, get an API key, and generate payment links in seconds. Customers pay in USDC — you receive it on Arc.',
              cta: 'Get Started',
              href: '/merchant/signup',
              isExternal: false,
            },
            {
              icon: '👤',
              title: 'Individuals',
              desc: 'Send money, request payments, and save automatically — just connect or create a wallet, no signup form.',
              cta: 'Get Started',
              href: '/consumer',
              isExternal: false,
            },
            {
              icon: '🤖',
              title: 'AI Agents',
              desc: 'Deploy ERC-8004 identity wallets and pay other agents per API call, per second, or per task — fully autonomous.',
              cta: 'View API docs ↗',
              href: 'https://docs.flarehq.xyz',
              isExternal: true,
            },
            {
              icon: '⚡',
              title: 'Developers',
              desc: 'Integrate FlareHQ APIs into your app. Initialize payments, verify settlements, stream USDC, and set up webhooks.',
              cta: 'Read the docs ↗',
              href: 'https://docs.flarehq.xyz',
              isExternal: true,
            },
          ].map((card, i) => (
            <div
              key={i}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 sm:p-8 flex flex-col hover:border-cyan-900/50 transition duration-300"
            >
              <div className="text-4xl mb-4">{card.icon}</div>
              <h3 className="text-xl font-bold mb-3">{card.title}</h3>
              <p className="text-[var(--text-secondary)] leading-relaxed flex-1 text-sm sm:text-base">{card.desc}</p>
              {card.isExternal ? (
                <a
                  href={card.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-6 text-cyan-400 text-sm font-semibold hover:text-cyan-300 transition inline-block whitespace-nowrap"
                >
                  {card.cta}
                </a>
              ) : (
                <Link
                  href={card.href}
                  className="mt-6 text-cyan-400 text-sm font-semibold hover:text-cyan-300 transition inline-block whitespace-nowrap"
                >
                  {card.cta} →
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-[var(--border)] py-10 sm:py-12 bg-[var(--background)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex flex-col items-center md:items-start gap-3">
            <div className="flex items-center gap-3">
              <Image src="/arcflare-logo.png.png" alt="FlareHQ" width={28} height={28} />
              <span className="font-bold tracking-tight text-lg">FlareHQ</span>
            </div>
            <p className="text-[var(--text-secondary)] text-xs sm:text-sm font-medium">
              © {new Date().getFullYear()} FlareHQ. All rights reserved.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4 text-sm font-medium text-[var(--text-secondary)]">
            <a href="https://docs.flarehq.xyz" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text)] transition whitespace-nowrap">
              Docs
            </a>
            <a href="#" className="hover:text-[var(--text)] transition whitespace-nowrap">
              Twitter / X
            </a>
            <a href="#" className="hover:text-[var(--text)] transition whitespace-nowrap">
              Support
            </a>
            <a href="#" className="hover:text-[var(--text)] transition whitespace-nowrap">
              Status
            </a>
            <a href="#" className="hover:text-[var(--text)] transition whitespace-nowrap">
              Privacy
            </a>
            <a href="#" className="hover:text-[var(--text)] transition whitespace-nowrap">
              Terms
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}