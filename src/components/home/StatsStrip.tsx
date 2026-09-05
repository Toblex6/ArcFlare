'use client';

import { useEffect, useRef, useState } from 'react';
import { animate, useInView, useReducedMotion } from 'framer-motion';

function Counter({ to, decimals = 0, prefix = '', suffix = '' }: { to: number; decimals?: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const reduce = useReducedMotion();
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setVal(to);
      return;
    }
    const controls = animate(0, to, {
      duration: 1.8,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setVal(v),
    });
    return () => controls.stop();
  }, [inView, to, reduce]);

  return (
    <span ref={ref}>
      {prefix}
      {val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

const STATS = [
  { value: 0.002, decimals: 3, prefix: '$', suffix: '', label: 'per x402 API call', note: 'Micro-billing gateway' },
  { value: 0.8, decimals: 1, prefix: '', suffix: 's', label: 'median settle', note: 'Arc Testnet live' },
  { value: 100, decimals: 0, prefix: '', suffix: '%', label: 'non-custodial', note: 'FlareHQ never holds funds' },
  { value: 9, decimals: 0, prefix: '', suffix: '+', label: 'languages in assistants', note: 'Voice AI, STT/TTS' },
];

export default function StatsStrip() {
  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 -mt-6 md:-mt-10 relative z-10">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-5">
        {STATS.map((s) => (
          <div
            key={s.label}
            className="bg-[var(--surface)]/90 backdrop-blur border border-[var(--border)] rounded-2xl p-5 md:p-6 shadow-lg hover:-translate-y-1 hover:shadow-xl transition duration-300"
          >
            <p className="text-2xl md:text-4xl font-extrabold tracking-tight text-[var(--text)]">
              <Counter to={s.value} decimals={s.decimals} prefix={s.prefix} suffix={s.suffix} />
            </p>
            <p className="mt-1 text-sm font-bold">{s.label}</p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{s.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
