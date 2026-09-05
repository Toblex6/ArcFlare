'use client';

import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import Link from 'next/link';
import SectionHeading from './SectionHeading';

const STEPS = [
  { n: '01', icon: '🪪', title: 'ERC-8004 identity', desc: 'Registry + reputation + validation. Score 0–100 with validator-signed trust.', href: '/agents' },
  { n: '02', icon: '🔎', title: 'Discover + procure', desc: 'Need → trust → treasury → select → hire. Autonomous pipeline.', href: '/procurement' },
  { n: '03', icon: '💼', title: 'ERC-8183 jobs', desc: 'Open → Funded → Submitted → Completed, with Telegram hiring loop.', href: '/jobs' },
  { n: '04', icon: '🧠', title: 'Agent Brain', desc: 'Chat to pay, hire, check reputation and prices via tool-calling.', href: '/agent-brain' },
  { n: '05', icon: '⚡', title: 'x402 marketplace', desc: 'Publish REST APIs, bill $0.002 per call, track revenue + success.', href: '/marketplace' },
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
            eyebrow="Agent economy — scroll sideways"
            title="Hire machines like people"
            sub="Keep scrolling — the track moves horizontally while the page moves vertically."
          />
        </div>
        <motion.div style={{ x }} className="flex gap-4 md:gap-6 px-4 sm:px-6 w-max max-w-none">
          {STEPS.map((s) => (
            <Link
              key={s.n}
              href={s.href}
              className="group w-[78vw] sm:w-[380px] shrink-0 bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 md:p-8 shadow-lg hover:shadow-2xl hover:border-cyan-500/40 hover:-translate-y-1.5 transition duration-300"
            >
              <div className="flex items-center justify-between mb-5">
                <span className="text-4xl group-hover:scale-110 transition-transform">{s.icon}</span>
                <span className="font-mono font-extrabold text-5xl text-[var(--border)] group-hover:text-cyan-500/40 transition">{s.n}</span>
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
        <p className="text-center text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)] mt-8 animate-pulse">
          ↓ keep scrolling — sideways motion ↓
        </p>
      </div>
    </section>
  );
}
