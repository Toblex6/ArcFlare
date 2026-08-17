// src/components/checkout/CheckoutError.tsx
// Display-only error state for the checkout page. No fetching, no API
// calls — the page passes the payment-shaped props in, plus an optional
// human-readable message from wherever the failure was detected.

import type { CheckoutPaymentInfo } from './CheckoutLoading';

export function CheckoutError({
  reference,
  merchantName,
  message,
}: CheckoutPaymentInfo & { message?: string | null }) {
  return (
    <div className="mx-auto w-full max-w-md" role="alert">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-8 py-10 backdrop-blur">
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 ring-1 ring-red-500/30">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f87171"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5" />
              <path d="M12 16.5h.01" />
            </svg>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold text-zinc-100">Something went wrong</h2>
            <p className="mx-auto max-w-xs text-xs leading-relaxed text-zinc-500">
              {message || 'We could not load this payment. Please try again in a moment.'}
            </p>
          </div>
        </div>

        <div className="mt-7 flex flex-col items-center gap-2 border-t border-zinc-800 pt-6">
          {reference ? (
            <p className="font-mono text-[11px] tracking-wide text-zinc-600">{reference}</p>
          ) : null}
          {merchantName ? (
            <p className="text-[11px] text-zinc-500">
              If the problem persists, contact {merchantName}.
            </p>
          ) : (
            <p className="text-[11px] text-zinc-500">
              If the problem persists, please contact the merchant.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}