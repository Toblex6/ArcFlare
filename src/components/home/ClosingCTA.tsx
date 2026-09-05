'use client';

import Link from 'next/link';
import Image from 'next/image';
import Reveal from './Reveal';

export default function ClosingCTA() {
  return (
    <>
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-14 md:pb-20">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 md:p-12">
            <div className="absolute -top-20 -right-20 h-64 w-64 rounded-full bg-cyan-400/20 blur-3xl" aria-hidden />
            <div className="absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-amber-300/20 blur-3xl" aria-hidden />
            <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-7">
              <div className="max-w-xl">
                <p className="text-xs font-extrabold uppercase tracking-widest text-cyan-600 dark:text-cyan-300 mb-2">
                  Telegram hiring loop
                </p>
                <h3 className="home-h3 text-2xl md:text-3xl font-extrabold mb-2">
                  Earn USDC from agent jobs — from Telegram.
                </h3>
                <p className="text-[var(--text-secondary)] text-sm md:text-base">
                  No wallet setup maze. <span className="font-mono font-bold">/jobs · /apply · /accept</span> — complete the work, get paid in USDC under escrow.
                </p>
                <div className="mt-4 flex gap-2 text-xs font-mono">
                  <span className="rounded-xl bg-[var(--surface-secondary)] border border-[var(--border)] px-3 py-2">you: /apply #4821</span>
                  <span className="rounded-xl bg-cyan-500/15 border border-cyan-500/25 px-3 py-2">bot: ✓ funded $250</span>
                </div>
              </div>
              <a
                href="https://t.me/FlareHQ_Notifier_bot"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 bg-cyan-500 hover:bg-cyan-400 text-white font-bold px-8 py-4 rounded-2xl transition shadow-[0_12px_32px_rgba(6,182,212,0.4)] hover:-translate-y-1 duration-300 text-center"
              >
                Open in Telegram →
              </a>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-4 rounded-3xl overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-cyan-900 text-white p-8 md:p-14 text-center shadow-2xl relative">
            <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,0.4)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.4)_1px,transparent_1px)] [background-size:36px_36px] [mask-image:radial-gradient(60%_80%_at_50%_50%,black,transparent)]" aria-hidden />
            <div className="relative">
              <h2 className="home-h2 text-3xl md:text-5xl font-extrabold tracking-tight mb-4">
                Start moving USDC in minutes.
              </h2>
              <p className="text-white/75 max-w-xl mx-auto mb-8">Checkout, payroll, escrow, streaming and agent billing — one stack on Arc.</p>
              <div className="flex flex-col sm:flex-row justify-center gap-3">
                <Link href="/start" className="bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-extrabold px-8 py-4 rounded-2xl transition hover:-translate-y-0.5 duration-300">
                  Get Started →
                </Link>
                <Link href="/marketplace" className="border border-white/25 hover:bg-white/10 font-bold px-8 py-4 rounded-2xl transition">
                  Explore APIs
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-[var(--border)] py-10 bg-[var(--background)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center md:items-start gap-2">
            <div className="flex items-center gap-2.5">
              <Image src="/arcflare-logo.png" alt="FlareHQ" width={26} height={26} />
              <span className="font-extrabold tracking-tight">FlareHQ</span>
            </div>
            <p className="text-[var(--text-secondary)] text-xs font-medium">© {new Date().getFullYear()} FlareHQ · Non-custodial · Arc Testnet</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm font-semibold text-[var(--text-secondary)]">
            <a href="https://docs.flarehq.xyz" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text)] transition">Docs</a>
            <a href="https://github.com/anomalyco/opencode" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text)] transition">GitHub</a>
            <Link href="/stats" className="hover:text-[var(--text)] transition">Stats</Link>
            <Link href="/jobs" className="hover:text-[var(--text)] transition">Jobs</Link>
          </div>
        </div>
      </footer>
    </>
  );
}
