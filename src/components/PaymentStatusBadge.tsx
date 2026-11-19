import { paymentStatusCategory, paymentStatusLabel } from "@/src/lib/payments/statusDisplay";

const STATUS_CLASSES = {
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  expired: "bg-slate-100 text-slate-600 border-slate-200",
  unknown: "bg-slate-50 text-slate-700 border-slate-200",
};

/** Merchant ledger badge: expiry is neutral, never styled as a transfer failure. */
export default function PaymentStatusBadge({ status }: { status: unknown }) {
  const category = paymentStatusCategory(status);
  return (
    <span
      data-payment-status={category}
      className={`inline-block rounded border px-2 py-1 text-[10px] font-semibold ${STATUS_CLASSES[category]}`}
    >
      {paymentStatusLabel(status)}
    </span>
  );
}
