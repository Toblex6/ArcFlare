'use client';

const ITEMS = ['USDC on Arc', 'x402 micro-billing', 'ERC-8004 agents', 'ERC-8183 jobs', 'CCTP bridge', 'Streaming', 'Escrow', 'Batch payroll', 'Telegram hiring'];

export default function Marquee() {
  const row = [...ITEMS, ...ITEMS];
  return (
    <div className="overflow-hidden border-y border-[var(--border)] bg-[var(--surface)]/60 py-3.5 select-none" aria-hidden>
      <div className="flex w-max gap-3 animate-[home-marquee_28s_linear_infinite]">
        {row.map((item, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--background)] px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
