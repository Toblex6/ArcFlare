'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import Reveal from './Reveal';
import SectionHeading from './SectionHeading';

const PILLARS = [
  {
    icon: '💰',
    title: 'Money',
    desc: 'Payments, checkout, payroll, escrow, treasury — the business money stack on Arc.',
    items: ['Checkout + payment links', 'Batch + chat payroll', 'Escrow milestones', 'Scheduled + auto-save'],
  },
  {
    icon: '🤖',
    title: 'Agents',
    desc: 'Identity, wallets, spend policies, reputation, procurement, jobs, Brain.',
    items: ['ERC-8004 wallets', 'Reputation + validation', 'ERC-8183 jobs', 'Agent Brain operator'],
  },
  {
    icon: '🧱',
    title: 'Infrastructure',
    desc: 'x402 micro-billing, APIs, webhooks, CCTP bridging on one ledger.',
    items: ['$0.002 x402 calls', 'APIs + docs', 'Settlement webhooks', 'CCTP bridge'],
  },
];

// The real job lifecycle: accept → fund → submit → validate → complete → ledger.
const LIFECYCLE = [
  { label: 'Discover', detail: 'find agents + jobs' },
  { label: 'Hire', detail: 'procurement selects' },
  { label: 'Fund', detail: 'USDC into escrow' },
  { label: 'Work', detail: 'provider submits' },
  { label: 'Validate', detail: 'validator approves' },
  { label: 'Pay', detail: 'settled · ledger updated' },
];

export default function SystemFlow() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setActive((a) => (a + 1) % LIFECYCLE.length), 1500);
    return () => clearInterval(id);
  }, [reduce]);

  return (
    <section id="system" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="One financial layer"
        title="Money, agents, infrastructure — one ledger"
        sub="Not a payments page with agent features. One set of canonical primitives: supported tokens, agent registry, jobs, escrow, ledger."
      />

      <div className="grid md:grid-cols-3 gap-4 md:gap-6 mb-10 md:mb-14">
        {PILLARS.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.08}>
            <div className="h-full bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 md:p-8 shadow-sm hover:shadow-lg hover:-translate-y-1 transition duration-300">
              <p className="text-4xl mb-4">{p.icon}</p>
              <h3 className="home-h3 text-xl font-extrabold mb-2">{p.title}</h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-5">{p.desc}</p>
              <ul className="space-y-2">
                {p.items.map((item) => (
                  <li key={item} className="text-sm font-semibold flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 md:p-10 shadow-sm">
          <p className="text-xs font-extrabold uppercase tracking-widest text-[var(--text-secondary)] mb-1">
            Live economic flow
          </p>
          <h3 className="home-h3 text-xl md:text-2xl font-extrabold mb-6">Every job moves the same way</h3>
          <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {LIFECYCLE.map((s, i) => {
              const done = reduce ? true : i < active;
              const current = !reduce && i === active;
              return (
                <li
                  key={s.label}
                  className={`relative rounded-2xl border p-4 transition-all duration-500 ${
                    current
                      ? 'border-cyan-500/60 bg-cyan-500/5 shadow-[0_0_0_4px_rgba(6,182,212,0.08)]'
                      : done
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-[var(--border)] bg-[var(--background)]'
                  }`}
                >
                  <p className={`font-mono text-[11px] font-bold mb-1.5 ${current ? 'text-cyan-600 dark:text-cyan-300' : done ? 'text-emerald-600 dark:text-emerald-300' : 'text-[var(--text-secondary)]'}`}>
                    {String(i + 1).padStart(2, '0')}{done && !current ? ' ✓' : current ? ' ●' : ''}
                  </p>
                  <p className="font-extrabold text-sm">{s.label}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">{s.detail}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </Reveal>
    </section>
  );
}
