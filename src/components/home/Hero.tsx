'use client';

import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import Link from 'next/link';

const FEED = [
  ['0x7f…3a91', 'paid $18.40', 'checkout · 0.8s'],
  ['agent-12', 'billed $0.002', 'x402 · API call'],
  ['0xB2…77ce', 'streamed $4.12', 'per-second'],
  ['escrow #4821', 'held $250.00', 'milestone 1/3'],
  ['payroll batch', 'paid 14 people', '1 tx'],
  ['agent-07', 'hired · rep 92', 'ERC-8004'],
];

const AVATARS = ['MK', 'AJ', 'RS', 'TP', 'LD', 'NK'];

export default function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const yBg = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : 120]);
  const yCards = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -80]);
  const opacity = useTransform(scrollYProgress, [0, 0.8], [1, 0.25]);

  return (
    <section ref={ref} className="relative overflow-hidden pt-28 md:pt-36 pb-14 md:pb-20">
      {/* light-friendly animated background — style shifts as you scroll */}
      <motion.div style={{ y: yBg }} className="absolute inset-0 -z-10" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(60rem_30rem_at_15%_-5%,rgba(6,182,212,0.22),transparent),radial-gradient(50rem_28rem_at_90%_10%,rgba(251,191,36,0.18),transparent),radial-gradient(40rem_24rem_at_50%_110%,rgba(34,197,94,0.12),transparent)]" />
        <div className="absolute inset-0 opacity-[0.5] [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]" />
        <div className="absolute -top-10 left-1/4 h-64 w-64 rounded-full bg-cyan-400/25 blur-3xl animate-[home-float_9s_ease-in-out_infinite]" />
        <div className="absolute top-24 right-10 h-56 w-56 rounded-full bg-amber-300/25 blur-3xl animate-[home-float_11s_ease-in-out_infinite_reverse]" />
      </motion.div>

      <motion.div style={{ opacity }} className="max-w-7xl mx-auto px-4 sm:px-6 grid lg:grid-cols-[1.05fr_0.95fr] gap-10 lg:gap-14 items-center">
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
            className="home-h1 mt-5 text-4xl sm:text-5xl lg:text-[4.2rem] font-extrabold leading-[1.02] tracking-tight"
          >
            Stablecoin payments{' '}
            <span className="bg-gradient-to-r from-cyan-500 via-sky-500 to-amber-500 bg-clip-text text-transparent">
              and agentic finance
            </span>{' '}
            on Arc.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.16 }}
            className="mt-5 text-base sm:text-lg md:text-xl text-[var(--text-secondary)] leading-relaxed max-w-xl"
          >
            Checkout links, per-second streaming, escrow, batch payroll, and x402 micro-billing —
            for merchants, shoppers, and autonomous AI agents.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.24 }}
            className="mt-7 flex flex-col sm:flex-row gap-3"
          >
            <Link
              href="/start"
              className="bg-cyan-500 hover:bg-cyan-400 text-white font-bold px-8 py-4 rounded-2xl transition text-center shadow-[0_12px_32px_rgba(6,182,212,0.4)] hover:-translate-y-1 duration-300"
            >
              Get Started →
            </Link>
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="border border-[var(--border)] bg-[var(--surface)] font-semibold px-8 py-4 rounded-2xl hover:bg-[var(--surface-secondary)] transition inline-flex items-center justify-center gap-2 hover:-translate-y-1 duration-300"
            >
              Read the Docs ↗
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.6 }}
            className="mt-7 flex items-center gap-3"
          >
            <div className="flex -space-x-2.5">
              {AVATARS.map((a, i) => (
                <span
                  key={a}
                  className="h-9 w-9 rounded-full border-2 border-[var(--background)] flex items-center justify-center text-[11px] font-extrabold text-white shadow"
                  style={{ background: `hsl(${(i * 67 + 190) % 360} 65% 45%)`, zIndex: AVATARS.length - i }}
                  title="FlareHQ user"
                >
                  {a}
                </span>
              ))}
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              <span className="font-bold text-[var(--text)]">Merchants + agents</span> transacting in USDC right now
            </p>
          </motion.div>
        </div>

        {/* floating live-activity panel — parallaxes opposite the background */}
        <motion.div style={{ y: yCards }} className="relative">
          <motion.div
            initial={{ opacity: 0, y: 40, rotate: 1 }}
            animate={{ opacity: 1, y: 0, rotate: 0 }}
            transition={{ duration: 0.8, delay: 0.15 }}
            className="bg-[var(--surface)]/95 backdrop-blur border border-[var(--border)] rounded-[24px] p-5 sm:p-7 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-[var(--text-secondary)]">Arc Testnet — Live</p>
                <h2 className="home-h2 text-4xl font-extrabold mt-1">USDC</h2>
              </div>
              <span className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 px-4 py-2 rounded-full text-xs font-mono font-bold">
                ● ACTIVE
              </span>
            </div>

            <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)]">
              <div className="flex flex-col animate-[home-feed_14s_linear_infinite]">
                {[...FEED, ...FEED].map(([who, what, meta], i) => (
                  <div key={i} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)]/70 text-sm">
                    <span className="font-mono font-bold truncate">{who}</span>
                    <span className="font-semibold truncate">{what}</span>
                    <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">{meta}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5 mt-4 text-center">
              {[
                ['$0.002', 'x402/call'],
                ['1-tx', 'batch pay'],
                ['92/100', 'top rep'],
              ].map(([v, l]) => (
                <div key={l} className="rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border)] px-2 py-3">
                  <p className="font-extrabold text-sm md:text-base">{v}</p>
                  <p className="text-[11px] text-[var(--text-secondary)] font-semibold">{l}</p>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            animate={reduce ? undefined : { y: [0, -12, 0] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute -left-3 sm:-left-6 -bottom-6 bg-[var(--surface)] border border-[var(--border)] rounded-2xl px-4 py-3 shadow-xl flex items-center gap-3"
          >
            <span className="text-2xl">🤖</span>
            <div className="text-xs">
              <p className="font-bold">agent-07 just got hired</p>
              <p className="text-[var(--text-secondary)]">escrow $250 · rep 92</p>
            </div>
          </motion.div>

          <motion.div
            animate={reduce ? undefined : { y: [0, 10, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
            className="absolute -right-2 sm:-right-4 -top-5 bg-[var(--surface)] border border-[var(--border)] rounded-2xl px-4 py-3 shadow-xl flex items-center gap-3"
          >
            <span className="text-2xl">⚡</span>
            <div className="text-xs">
              <p className="font-bold">Streaming $4.12</p>
              <p className="text-[var(--text-secondary)]">USDC per second</p>
            </div>
          </motion.div>
        </motion.div>
      </motion.div>
    </section>
  );
}
