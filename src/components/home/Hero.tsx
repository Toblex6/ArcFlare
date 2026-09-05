'use client';

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';

// The actual money path through FlareHQ — the hero visual.
// USDC payment → checkout → escrow → agent → validation → settlement.
const FLOW = [
  { label: 'USDC payment', detail: '$12.00 · Arc Testnet', icon: '💵' },
  { label: 'Checkout', detail: 'link + embed · settled to merchant', icon: '🧾' },
  { label: 'Escrow', detail: '#4821 · held $250 · milestone 1/3', icon: '🔐' },
  { label: 'Agent hired', detail: 'agent-07 · ERC-8004 · rep 92', icon: '🤖' },
  { label: 'Validation', detail: 'validator approved work', icon: '✅' },
  { label: 'Settlement', detail: 'provider paid · ledger updated', icon: '🏦' },
];

export default function Hero() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setActive((a) => (a + 1) % FLOW.length), 1600);
    return () => clearInterval(id);
  }, [reduce]);

  return (
    <section className="relative overflow-hidden pt-28 md:pt-36 pb-14 md:pb-20">
      {/* calm light-friendly backdrop — static, no scroll interpolation */}
      <div className="absolute inset-0 -z-10" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(60rem_30rem_at_15%_-5%,rgba(6,182,212,0.16),transparent),radial-gradient(50rem_28rem_at_90%_10%,rgba(251,191,36,0.12),transparent)]" />
        <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]" />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 grid lg:grid-cols-[1.05fr_0.95fr] gap-10 lg:gap-14 items-center">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)]/90 px-4 py-2 text-xs sm:text-sm font-semibold shadow-sm"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <span className="text-[var(--text)]">Live on Arc Testnet</span>
            <span className="text-[var(--text-secondary)]">· USDC · non-custodial</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08 }}
            className="home-h1 mt-5 text-4xl sm:text-5xl lg:text-[3.9rem] font-extrabold leading-[1.04] tracking-tight"
          >
            The financial operating layer for{' '}
            <span className="bg-gradient-to-r from-cyan-500 via-sky-500 to-amber-500 bg-clip-text text-transparent">
              stablecoin businesses and autonomous agents
            </span>
            .
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.16 }}
            className="mt-5 text-base sm:text-lg md:text-xl text-[var(--text-secondary)] leading-relaxed max-w-xl"
          >
            FlareHQ gives businesses and AI agents the money layer they need to transact, hire,
            pay, and settle autonomously on Arc. Customers pay in USDC — you receive it on Arc.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.24 }}
            className="mt-7 flex flex-col sm:flex-row gap-3"
          >
            <Link
              href="/start"
              className="bg-cyan-500 hover:bg-cyan-400 text-white font-bold px-8 py-4 rounded-2xl transition text-center shadow-[0_12px_32px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 duration-300"
            >
              Start using FlareHQ →
            </Link>
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-[var(--border)] bg-[var(--surface)] font-semibold px-8 py-4 rounded-2xl hover:bg-[var(--surface-secondary)] transition inline-flex items-center justify-center gap-2 hover:-translate-y-0.5 duration-300"
            >
              Build with FlareHQ ↗
            </a>
          </motion.div>
        </div>

        {/* live system card — animates the real money path, step by step */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.15 }}
          className="bg-[var(--surface)]/95 backdrop-blur border border-[var(--border)] rounded-[24px] p-5 sm:p-7 shadow-2xl"
        >
          <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
            <div>
              <p className="text-xs uppercase tracking-widest font-bold text-[var(--text-secondary)]">Money in motion</p>
              <h2 className="home-h2 text-2xl font-extrabold mt-1">Payment → settlement</h2>
            </div>
            <span className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 px-4 py-2 rounded-full text-xs font-mono font-bold">
              ● EXAMPLE FLOW
            </span>
          </div>

          <ol className="relative">
            {FLOW.map((step, i) => {
              const done = reduce ? true : i < active;
              const current = !reduce && i === active;
              return (
                <li key={step.label} className="relative flex gap-4 pb-1 last:pb-0">
                  {i < FLOW.length - 1 && (
                    <span
                      aria-hidden
                      className={`absolute left-[19px] top-10 bottom-0 w-0.5 transition-colors duration-500 ${
                        done ? 'bg-emerald-500/60' : 'bg-[var(--border)]'
                      }`}
                    />
                  )}
                  <span
                    className={`relative z-10 h-10 w-10 shrink-0 rounded-full border flex items-center justify-center text-lg transition-all duration-500 ${
                      current
                        ? 'border-cyan-500 bg-cyan-500/15 shadow-[0_0_0_5px_rgba(6,182,212,0.12)]'
                        : done
                          ? 'border-emerald-500/50 bg-emerald-500/10'
                          : 'border-[var(--border)] bg-[var(--surface-secondary)]'
                    }`}
                  >
                    {step.icon}
                    {current && (
                      <span className="absolute inset-0 rounded-full border-2 border-cyan-400/50 animate-ping" aria-hidden />
                    )}
                  </span>
                  <div className={`flex-1 rounded-2xl border px-4 py-2.5 mb-2.5 transition-all duration-500 ${
                    current
                      ? 'border-cyan-500/50 bg-cyan-500/5'
                      : 'border-[var(--border)] bg-[var(--background)]'
                  }`}>
                    <p className="font-bold text-sm">
                      {done && !current ? '✓ ' : ''}{step.label}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] font-mono mt-0.5">{step.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </motion.div>
      </div>
    </section>
  );
}
