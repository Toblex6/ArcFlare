// src/lib/payments/statusDisplay.ts
//
// Single authority for human-readable payment/activity status labels.
//
// Stored `status` values (SUCCESS, PENDING, SETTLEMENT_ERROR, FAILED,
// EXPIRED, …) are machine codes and must never be shown raw in consumer or
// merchant views. This helper maps them to plain text for DISPLAY ONLY —
// it never mutates stored rows. Unknown codes fall through unchanged so no
// information is hidden.

export type PaymentStatusCategory = "success" | "pending" | "failed" | "expired" | "unknown";

/** Display-only grouping. Expiry is not a failed payment; unknown is not pending. */
export function paymentStatusCategory(status: unknown): PaymentStatusCategory {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "SUCCESS":
    case "COMPLETED":
    case "EXECUTED":
      return "success";
    case "SETTLEMENT_ERROR":
    case "FAILED":
    case "ATTESTATION_FAILED":
      return "failed";
    case "PENDING":
    case "PROCESSING_ONCHAIN":
      return "pending";
    case "EXPIRED":
      return "expired";
    default:
      return "unknown";
  }
}

/** Count the server-supplied display statuses without changing any ledger row. */
export function countPaymentStatuses(statuses: Iterable<unknown>): Record<PaymentStatusCategory, number> {
  const counts = { success: 0, pending: 0, failed: 0, expired: 0, unknown: 0 };
  for (const status of statuses) counts[paymentStatusCategory(status)] += 1;
  return counts;
}

/** Plain-text display label for a stored payment/activity status code. */
export function paymentStatusLabel(status: unknown): string {
  switch (paymentStatusCategory(status)) {
    case "success":
      return "Sent";
    case "failed":
      return "Failed — no money moved";
    case "pending":
      return "Pending — no transaction yet";
    case "expired":
      return "Expired — link no longer valid";
    default:
      return String(status ?? "");
  }
}
