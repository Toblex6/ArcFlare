'use client';

import Reveal from './Reveal';
import SectionHeading from './SectionHeading';
import { useArcLabel } from '@/src/components/NetworkContext';

const CODE = `// Use the reference returned by an authenticated
// POST /api/payments/initialize request.
<iframe src={checkoutEmbedUrl} />
// Customer pays directly to the merchant wallet.
// Re-verify the reference before fulfilling an order.

// Mainnet: x402 disabled; escrow and ERC-8183
// job streams unavailable. Check the docs first.`;

export default function DevSplit() {
  // Server-resolved network label (production-safe "Arc" default until
  // /api/network resolves) — never client-side env (testnet fallback).
  const arcName = useArcLabel();
  return (
    <section id="developers" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="Developers"
        title="Integrate with clear availability checks"
        sub="Checkout embeds, authentication and settlement verification. Mainnet x402 remains disabled."
      />
      <div className="grid lg:grid-cols-2 gap-4 md:gap-6 items-stretch">
        <Reveal>
          <div className="h-full rounded-3xl overflow-hidden border border-[var(--border)] bg-[#0b1220] shadow-xl">
            <div className="flex items-center gap-1.5 px-5 py-3.5 border-b border-white/10">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-amber-300" />
              <span className="h-3 w-3 rounded-full bg-emerald-400" />
              <span className="ml-3 text-xs font-mono text-white/50">flarehq-integration.ts</span>
            </div>
            <pre className="p-5 md:p-6 text-[12.5px] md:text-sm leading-relaxed font-mono text-cyan-100 overflow-x-auto whitespace-pre">{CODE}</pre>
          </div>
        </Reveal>
        <div className="flex flex-col gap-4">
          <Reveal delay={0.08}>
            <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 md:p-7 shadow-sm">
              <p className="text-xs font-extrabold uppercase tracking-widest text-[var(--text-secondary)] mb-3">Illustrative receipt — not a verified transaction</p>
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-extrabold text-sm">Payment settled · $18.40 USDC</p>
                  <p className="text-xs text-[var(--text-secondary)] font-mono mt-0.5">{arcName} · customer → merchant wallet</p>
                </div>
                <span className="text-2xl">✅</span>
              </div>
              <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4 text-xs font-mono text-[var(--text-secondary)]">
                payment.settled notification → server-side verification → fulfill once
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.16}>
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center rounded-2xl bg-slate-900 dark:bg-cyan-500 text-white font-bold px-6 py-4 hover:-translate-y-0.5 transition duration-300 shadow-lg"
            >
              Read the docs ↗
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
