// src/components/checkout/CheckoutLoading.tsx
// Display-only loading state for the checkout page. No fetching, no API
// calls — the page decides when to show it and passes the reference in.

export interface CheckoutPaymentInfo {
  reference?: string | null;
  status?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  merchantName?: string | null;
  expiresAt?: string | Date | null;
  transactionHash?: string | null;
}

export function CheckoutLoading({ reference }: CheckoutPaymentInfo) {
  return (
    <div className="mx-auto w-full max-w-md" role="status" aria-live="polite">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-8 py-12 backdrop-blur">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="relative h-10 w-10">
            <div className="absolute inset-0 rounded-full border-2 border-zinc-800" />
            <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#c8975a]" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-100">Loading payment details</p>
            <p className="text-xs text-zinc-500">This should only take a moment.</p>
          </div>
          {reference ? (
            <p className="font-mono text-[11px] tracking-wide text-zinc-600">{reference}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
