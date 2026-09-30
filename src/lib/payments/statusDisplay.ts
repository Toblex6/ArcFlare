// src/lib/payments/statusDisplay.ts
//
// Single authority for human-readable payment/activity status labels.
//
// Stored `status` values (SUCCESS, PENDING, SETTLEMENT_ERROR, FAILED,
// EXPIRED, …) are machine codes and must never be shown raw in consumer or
// merchant views. This helper maps them to plain text for DISPLAY ONLY —
// it never mutates stored rows. Unknown codes fall through unchanged so no
// information is hidden.

/** Plain-text display label for a stored payment/activity status code. */
export function paymentStatusLabel(status: unknown): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "SUCCESS":
    case "COMPLETED":
    case "EXECUTED":
      return "Sent";
    case "SETTLEMENT_ERROR":
    case "FAILED":
    case "ATTESTATION_FAILED":
      return "Failed — no money moved";
    case "PENDING":
    case "PROCESSING_ONCHAIN":
      return "Pending — no transaction yet";
    case "EXPIRED":
      return "Expired — link no longer valid";
    default:
      return String(status ?? "");
  }
}
