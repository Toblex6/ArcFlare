'use client';

import Reveal from './Reveal';
import SectionHeading from './SectionHeading';

const CODE = `// Pay-per-call with x402 — <5 min
const res = await fetch(api + "/expensive", {
  headers: { Authorization: "Bearer fhq_sec_..." }
});
// 402 → pay $0.002 from gateway → retry → 200

// Embed checkout anywhere
<iframe src="https://flarehq.xyz/checkout/embed/abc123" />
// Webhook: payment.settled → ship it`;

export default function DevSplit() {
  return (
    <section id="developers" className="max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 scroll-mt-24">
      <SectionHeading
        eyebrow="Developers"
        title="Integrate in an afternoon"
        sub="API keys, OpenAPI, webhooks, embeds and SDKs. Quickstart under five minutes."
      />
      <div className="grid lg:grid-cols-2 gap-4 md:gap-6 items-stretch">
        <Reveal>
          <div className="h-full rounded-3xl overflow-hidden border border-[var(--border)] bg-[#0b1220] shadow-xl">
            <div className="flex items-center gap-1.5 px-5 py-3.5 border-b border-white/10">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-amber-300" />
              <span className="h-3 w-3 rounded-full bg-emerald-400" />
              <span className="ml-3 text-xs font-mono text-white/50">flarehq-integration.ts</span>
            </div>
            <pre className="p-5 md:p-6 text-[12.5px] md:text-sm leading-relaxed font-mono text-cyan-100 overflow-x-auto whitespace-pre">{CODE}</pre>
          </div>
        </Reveal>
        <div className="flex flex-col gap-4">
          <Reveal delay={0.08}>
            <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 md:p-7 shadow-sm">
              <p className="text-xs font-extrabold uppercase tracking-widest text-[var(--text-secondary)] mb-3">Live receipt</p>
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-extrabold text-sm">Payment settled · $18.40 USDC</p>
                  <p className="text-xs text-[var(--text-secondary)] font-mono mt-0.5">arc testnet · 0x7f…3a91 → merchant</p>
                </div>
                <span className="text-2xl">✅</span>
              </div>
              <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4 text-xs font-mono text-[var(--text-secondary)]">
                webhook: payment.settled → order #1042 → shipped
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.16}>
            <div className="grid grid-cols-3 gap-3">
              {[
                ['<5min', 'quickstart'],
                ['fhq_sec_', 'API keys'],
                ['402', 'x402 native'],
              ].map(([v, l]) => (
                <div key={l} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center shadow-sm hover:-translate-y-1 transition duration-300">
                  <p className="font-extrabold">{v}</p>
                  <p className="text-[11px] text-[var(--text-secondary)] font-bold uppercase tracking-wider mt-0.5">{l}</p>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={0.22}>
            <a
              href="https://docs.flarehq.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center rounded-2xl bg-slate-900 dark:bg-cyan-500 text-white font-bold px-6 py-4 hover:-translate-y-0.5 transition duration-300 shadow-lg"
            >
              Read the docs ↗
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
