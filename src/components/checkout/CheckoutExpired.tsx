// src/components/checkout/CheckoutExpired.tsx
// Display-only "payment link expired" state for the checkout page. No
// fetching, no API calls — the page passes the payment-shaped props in.

import type { CheckoutPaymentInfo } from './CheckoutLoading';

function formatAmount(amount: number | string | null | undefined, currency: string | null | undefined) {
  const value = Number(amount ?? 0);
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
  return currency ? `${formatted} ${currency.toUpperCase()}` : formatted;
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
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

export function CheckoutExpired({
  reference,
  amount,
  currency,
  merchantName,
  expiresAt,
}: CheckoutPaymentInfo) {
  const expiresLabel = formatDate(expiresAt);
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-8 py-10 backdrop-blur">
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 ring-1 ring-amber-500/30">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#c8975a"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
              <path d="M4.5 4.5l15 15" />
            </svg>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold text-zinc-100">Payment link expired</h2>
            <p className="mx-auto max-w-xs text-xs leading-relaxed text-zinc-500">
              This payment link is no longer valid.
              {merchantName
                ? ` If you would still like to pay, ask ${merchantName} to issue a new link.`
                : ' Ask the merchant to issue a new link.'}
            </p>
          </div>
        </div>

        <div className="mt-7 divide-y divide-zinc-800 border-t border-b border-zinc-800">
          <InfoRow label="Amount" value={formatAmount(amount, currency)} />
          {merchantName ? <InfoRow label="Merchant" value={merchantName} /> : null}
          {expiresLabel ? <InfoRow label="Expired" value={expiresLabel} /> : null}
          {reference ? <InfoRow label="Reference" value={reference} mono /> : null}
        </div>
      </div>
    </div>
  );
}
