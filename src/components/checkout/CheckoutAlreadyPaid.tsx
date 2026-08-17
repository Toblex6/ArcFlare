// src/components/checkout/CheckoutAlreadyPaid.tsx
// Display-only "already paid" state for the checkout page. No fetching,
// no API calls — the page passes the payment-shaped props in.

import type { CheckoutPaymentInfo } from './CheckoutLoading';

function formatAmount(amount: number | string | null | undefined, currency: string | null | undefined) {
  const value = Number(amount ?? 0);
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
  return currency ? `${formatted} ${currency.toUpperCase()}` : formatted;
}

function shortenHash(hash: string) {
  if (hash.length <= 20) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={`text-right text-xs text-zinc-200 ${mono ? 'font-mono tracking-wide' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export function CheckoutAlreadyPaid({
  reference,
  amount,
  currency,
  merchantName,
  transactionHash,
}: CheckoutPaymentInfo) {
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-8 py-10 backdrop-blur">
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#34d399"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M8.5 12.5l2.5 2.5 4.5-5" />
            </svg>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold text-zinc-100">Payment already completed</h2>
            <p className="mx-auto max-w-xs text-xs leading-relaxed text-zinc-500">
              This payment was already settled on-chain. No further action is needed.
            </p>
          </div>
          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium tracking-wide text-emerald-400 ring-1 ring-emerald-500/20">
            PAID
          </span>
        </div>

        <div className="mt-7 divide-y divide-zinc-800 border-t border-b border-zinc-800">
          <InfoRow label="Amount" value={formatAmount(amount, currency)} />
          {merchantName ? <InfoRow label="Merchant" value={merchantName} /> : null}
          {reference ? <InfoRow label="Reference" value={reference} mono /> : null}
          {transactionHash ? (
            <InfoRow label="Transaction" value={shortenHash(transactionHash)} mono />
          ) : null}
        </div>
      </div>
    </div>
  );
}