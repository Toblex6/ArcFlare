'use client';

import Link from 'next/link';
import Reveal from './Reveal';
import SectionHeading from './SectionHeading';

const PRODUCTS = [
  {
    icon: '🧾',
    title: 'Checkout + payment links',
    desc: 'Shareable links and iframe embeds. Customers pay in USDC — you receive it on Arc.',
    href: '/start',
    tag: 'Business',
  },
  {
    icon: '🌊',
    title: 'Per-second streaming',
    desc: 'USDC drips every second to receivers. Salaries and grants — live.',
    href: '/stats',
    tag: 'Money',
  },
  {
    icon: '🔐',
    title: 'Escrow milestones',
    desc: 'Milestone holds with ACTIVE / RELEASED / DISPUTED states and first-class beneficiaries.',
    href: '/escrow',
    tag: 'Trust',
  },
  {
    icon: '💸',
    title: 'Batch + chat payroll',
    desc: 'Pay N people in one tx, or type “pay Alice 100 monthly” and let the assistant run it.',
    href: '/payroll',
    tag: 'Payroll',
  },
  {
    icon: '🔁',
    title: 'Scheduled + auto-save',
    desc: 'Recurring payments and recurring self-transfer savings that run themselves.',
    href: '/scheduled',
    tag: 'Recurring',
  },
  {
    icon: '🌉',
    title: 'CCTP bridge + x402',
    desc: 'Cross-chain USDC routing and $0.002-per-call API micro-billing via HTTP 402.',
    href: '/marketplace',
    tag: 'Infrastructure',
  },
];

export default function ProductGrid() {
  return (
    <section id="products" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="Core products"
        title="Six things that are strong today"
        sub="Only real, live surfaces — no yield, lending, cards, or DEX promises. Every card opens the actual product."
      />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        {PRODUCTS.map((p, i) => (
          <Reveal key={p.title} delay={(i % 3) * 0.08}>
            <div className="group h-full bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 md:p-7 flex flex-col shadow-sm hover:shadow-lg hover:border-cyan-500/40 hover:-translate-y-1 transition duration-300">
              <div className="flex items-center justify-between mb-4">
                <span className="text-3xl">{p.icon}</span>
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-700 dark:text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-2.5 py-1">
                  {p.tag}
                </span>
              </div>
              <h3 className="home-h3 text-lg md:text-xl font-extrabold mb-2">{p.title}</h3>
              <p className="text-sm md:text-[15px] text-[var(--text-secondary)] leading-relaxed flex-1">{p.desc}</p>
              <Link href={p.href} className="mt-5 text-sm font-bold text-cyan-600 dark:text-cyan-300 inline-flex items-center gap-2 hover:gap-3 transition-all">
                Open live →
              </Link>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
