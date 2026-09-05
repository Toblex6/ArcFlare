'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import Reveal from './Reveal';
import SectionHeading from './SectionHeading';

const PRODUCTS = [
  {
    icon: '🧾',
    title: 'Hosted checkout + embeds',
    desc: 'Shareable links, iframe embeds, invoices. Customers pay USDC straight to your wallet.',
    href: '/start',
    tag: 'Merchants',
  },
  {
    icon: '🌊',
    title: 'Per-second streaming',
    desc: 'USDC drips every second to receivers. Salaries, grants, subscriptions — live.',
    href: '/stats',
    tag: 'Streams',
  },
  {
    icon: '🔐',
    title: 'Escrow + disputes',
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
    desc: 'Recurring payments, savings plans and payroll schedules that run themselves.',
    href: '/scheduled',
    tag: 'Recurring',
  },
  {
    icon: '🌉',
    title: 'CCTP bridge + x402',
    desc: 'Cross-chain USDC routing and $0.002-per-call API micro-billing via HTTP 402.',
    href: '/marketplace',
    tag: 'Developers',
  },
];

export default function ProductGrid() {
  return (
    <section id="products" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="What you can do"
        title="Everything money needs to do on Arc"
        sub="Six live primitives — not slides. Every card links to the real product in this codebase."
      />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        {PRODUCTS.map((p, i) => (
          <Reveal key={p.title} delay={(i % 3) * 0.08}>
            <motion.div
              whileHover={{ y: -6, rotateX: 2, rotateY: -2 }}
              transition={{ type: 'spring', stiffness: 300, damping: 22 }}
              className="group h-full bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 md:p-7 flex flex-col shadow-sm hover:shadow-xl hover:border-cyan-500/40 transition-shadow duration-300"
              style={{ transformPerspective: 800 }}
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-3xl group-hover:scale-110 transition-transform">{p.icon}</span>
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-700 dark:text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-2.5 py-1">
                  {p.tag}
                </span>
              </div>
              <h3 className="home-h3 text-lg md:text-xl font-extrabold mb-2">{p.title}</h3>
              <p className="text-sm md:text-[15px] text-[var(--text-secondary)] leading-relaxed flex-1">{p.desc}</p>
              <Link href={p.href} className="mt-5 text-sm font-bold text-cyan-600 dark:text-cyan-300 hover:gap-3 gap-2 inline-flex items-center transition-all">
                Open live → 
              </Link>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
