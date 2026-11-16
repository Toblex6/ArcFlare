'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import SectionHeading from './SectionHeading';

const TABS = [
  {
    id: 'merchants',
    icon: '🏪',
    label: 'Merchants',
    title: 'Accept USDC through checkout',
    desc: 'Sign up, get an API key, share a link. Checkout is non-custodial — customers pay directly into your wallet; FlareHQ never holds checkout funds.',
    points: ['Hosted + embedded checkout', 'Payment links + webhooks', 'External wallets'],
    cta: 'Merchant signup',
    href: '/merchant/signup',
  },
  {
    id: 'individuals',
    icon: '👤',
    label: 'Individuals',
    title: 'Send, request and save tools',
    desc: 'Sign in with a wallet you control. Own-wallet requests do not move funds; sends and savings retain payment-code checks.',
    points: ['Send / request USDC', 'Auto-save plans', 'Voice assistant in 9+ languages'],
    cta: 'Open consumer app',
    href: '/consumer',
  },
  {
    id: 'agents',
    icon: '🤖',
    label: 'AI Agents',
    title: 'Explore agent identity and postings',
    desc: 'ERC-8004 identity and SCA wallets do not enable mainnet jobs by themselves. ERC-8183 jobs, escrow and job streams are unavailable; x402 is disabled.',
    points: ['Backend-supplied reputation', 'Read-only job browsing', 'Telegram: mainnet job actions unavailable'],
    cta: 'Explore agents',
    href: '/agents',
  },
  {
    id: 'developers',
    icon: '⚡',
    label: 'Developers',
    title: 'Integrate with availability-aware APIs',
    desc: 'Initialize and verify checkout payments. Check each endpoint’s network, authentication and availability requirements before using it.',
    points: ['APIs + docs', 'Re-verify settlement notifications', 'Explicit unavailable responses'],
    cta: 'Read the docs',
    href: 'https://docs.flarehq.xyz',
  },
];

export default function PersonaTabs() {
  const [active, setActive] = useState(TABS[0].id);
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];
  const isExternal = tab.href.startsWith('http');

  return (
    <section id="personas" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="Who it's for"
        title="For businesses. For people. For agents."
        sub="One money layer, four front doors. Pick yours."
      />
      <div className="flex flex-wrap justify-center gap-2 mb-8">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`relative rounded-full px-5 py-2.5 text-sm font-bold transition ${
              active === t.id ? 'text-white' : 'text-[var(--text-secondary)] bg-[var(--surface)] border border-[var(--border)] hover:text-[var(--text)]'
            }`}
          >
            {active === t.id && (
              <motion.span layoutId="persona-pill" className="absolute inset-0 rounded-full bg-slate-900 dark:bg-cyan-500" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />
            )}
            <span className="relative z-10">
              {t.icon} {t.label}
            </span>
          </button>
        ))}
      </div>

      <div className="max-w-3xl mx-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.3 }}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-7 md:p-10 text-center shadow-lg"
          >
            <p className="text-5xl mb-4">{tab.icon}</p>
            <h3 className="home-h3 text-2xl md:text-3xl font-extrabold mb-3">{tab.title}</h3>
            <p className="text-[var(--text-secondary)] leading-relaxed mb-6">{tab.desc}</p>
            <div className="flex flex-wrap justify-center gap-2 mb-7">
              {tab.points.map((p) => (
                <span key={p} className="text-xs font-bold rounded-full bg-[var(--surface-secondary)] border border-[var(--border)] px-3.5 py-1.5">
                  ✓ {p}
                </span>
              ))}
            </div>
            {isExternal ? (
              <a
                href={tab.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block bg-cyan-500 hover:bg-cyan-400 text-white font-bold px-8 py-3.5 rounded-2xl transition shadow-[0_10px_28px_rgba(6,182,212,0.35)]"
              >
                {tab.cta} ↗
              </a>
            ) : (
              <Link
                href={tab.href}
                className="inline-block bg-cyan-500 hover:bg-cyan-400 text-white font-bold px-8 py-3.5 rounded-2xl transition shadow-[0_10px_28px_rgba(6,182,212,0.35)]"
              >
                {tab.cta} →
              </Link>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
