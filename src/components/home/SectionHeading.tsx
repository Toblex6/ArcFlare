'use client';

import Reveal from './Reveal';

export default function SectionHeading({
  eyebrow,
  title,
  sub,
  align = 'center',
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  align?: 'center' | 'left';
}) {
  const alignCls = align === 'center' ? 'text-center mx-auto items-center' : 'text-left items-start';
  return (
    <Reveal className={`max-w-3xl flex flex-col gap-4 mb-10 md:mb-14 ${alignCls}`}>
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-600 dark:text-cyan-300">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-pulse" />
        {eyebrow}
      </span>
      <h2 className="home-h2 text-3xl md:text-5xl font-extrabold tracking-tight leading-[1.05]">{title}</h2>
      {sub ? <p className="text-base md:text-lg text-[var(--text-secondary)] leading-relaxed">{sub}</p> : null}
    </Reveal>
  );
}
