'use client';

import Link from 'next/link';
import Reveal from './Reveal';
import SectionHeading from './SectionHeading';

const PRODUCTS: {
  icon: string;
  title: string;
  desc: string;
  href: string;
  tag: string;
}[] = [
  {
    icon: '🧾',
    title: 'Checkout + payment links',
    desc: 'Shareable links and iframe embeds. Customers pay in USDC — you receive it on Arc.',
    href: '/start',
    tag: 'Business',
  },
  {
    icon: '🌊',
    title: 'Streaming payments',
    desc: 'Criterion-based job tranches require ERC-8183, currently unavailable on mainnet. Legacy per-second streams are disabled.',
    href: '/docs/api',
    tag: 'API',
  },
  {
    icon: '🔐',
    title: 'Escrow milestones',
    desc: 'Unavailable on mainnet pending contract deployment and verification. Escrow endpoints return 503.',
    href: '/escrow',
    tag: 'Trust',
  },
  {
    icon: '💸',
    title: 'Batch + chat payroll',
    desc: 'Batch and assistant payroll tools. Mainnet execution has not been verified in the current readiness run.',
    href: '/payroll',
    tag: 'Payroll',
  },
  {
    icon: '🔁',
    title: 'Scheduled + auto-save',
    desc: 'Recurring payment and savings tools. Mainnet execution has not been verified in the current readiness run.',
    href: '/scheduled',
    tag: 'Recurring',
  },
  {
    icon: '🌉',
    title: 'CCTP bridge',
    desc: 'CCTP bridge tools require a supported source and wallet authorization. Mainnet transfer completion awaits an owner-run test.',
    href: '/consumer?view=crosschain',
    tag: 'Bridge',
  },
];

export default function ProductGrid() {
  return (
    <section id="products" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="Core products"
        title="Product availability"
        sub="Mainnet readiness as of November 16, 2026. A page or API being present is not proof of successful payment execution."
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
                View →
              </Link>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
