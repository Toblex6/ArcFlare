'use client';

import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import Link from 'next/link';
import SectionHeading from './SectionHeading';

const STEPS = [
  { n: '01', icon: '🪪', title: 'Identity', desc: 'ERC-8004 wallets + on-chain registry. Every agent has an address.', href: '/agents' },
  { n: '02', icon: '⭐', title: 'Reputation', desc: 'Scores 0–100 with validator-signed trust. Hire on evidence.', href: '/agents' },
  { n: '03', icon: '🔎', title: 'Procurement', desc: 'Need → trust → treasury → select → hire. Autonomous pipeline.', href: '/procurement' },
  { n: '04', icon: '💼', title: 'Jobs', desc: 'ERC-8183 lifecycle: accept → fund → submit → validate → complete.', href: '/jobs' },
  { n: '05', icon: '🧠', title: 'Brain', desc: 'Chat operator: pay, hire, check reputation and prices via tools.', href: '/agent-brain' },
  { n: '06', icon: '💸', title: 'Payments', desc: 'Streaming wages, escrowed settlement, ledger updated.', href: '/payroll' },
];

export default function AgentRail() {
  const targetRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: targetRef });
  const x = useTransform(scrollYProgress, [0, 1], ['4%', reduce ? '4%' : '-62%']);

  return (
    <section id="agents" ref={targetRef} className="relative h-[300vh] scroll-mt-24">
      <div className="sticky top-0 h-screen flex flex-col justify-center overflow-hidden bg-gradient-to-b from-transparent via-[var(--surface-secondary)]/60 to-transparent">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 w-full">
          <SectionHeading
            align="left"
            eyebrow="Agent economy — keep scrolling"
            title="Identity → reputation → jobs → payment"
            sub="The concept itself is sequential, so the track moves sideways as you scroll down."
          />
        </div>
        <motion.div style={{ x }} className="flex gap-4 md:gap-6 px-4 sm:px-6 w-max max-w-none">
          {STEPS.map((s) => (
            <Link
              key={s.n}
              href={s.href}
              className="group w-[78vw] sm:w-[380px] shrink-0 bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 md:p-8 shadow-lg hover:shadow-xl hover:border-cyan-500/40 hover:-translate-y-1 transition duration-300"
            >
              <div className="flex items-center justify-between mb-5">
                <span className="text-4xl">{s.icon}</span>
                <span className="font-mono font-extrabold text-5xl text-[var(--border)]">{s.n}</span>
              </div>
              <h3 className="home-h3 text-xl md:text-2xl font-extrabold mb-2">{s.title}</h3>
              <p className="text-sm md:text-base text-[var(--text-secondary)] leading-relaxed">{s.desc}</p>
              <span className="mt-5 inline-flex text-sm font-bold text-cyan-600 dark:text-cyan-300">Open {s.href} →</span>
            </Link>
          ))}
          <div className="w-[78vw] sm:w-[380px] shrink-0 rounded-3xl p-8 bg-gradient-to-br from-cyan-500 to-sky-600 text-white flex flex-col justify-center shadow-xl">
            <p className="text-3xl mb-3">🚀</p>
            <h3 className="text-2xl font-extrabold mb-2">Deploy your agent today</h3>
            <p className="text-white/85 text-sm leading-relaxed">ERC-8004 wallet, treasury, reputation — live in minutes.</p>
            <span className="mt-5 inline-flex w-fit bg-white text-slate-900 font-bold text-sm px-5 py-3 rounded-xl">Get started →</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
