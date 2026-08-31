// src/lib/errors/errorMapper.ts
// Small reusable mapper: raw Circle/API errors -> friendly codes, logs full detail server-side.

export type FriendlyCode = "INSUFFICIENT_FUNDS" | "VALIDATION_REQUIRED" | "UNAUTHORIZED" | "UNKNOWN";

export function mapApiError(e: any): { code: FriendlyCode; message: string } {
  const raw = String(e?.message ?? e ?? "");
  // preserve detail in console/Sentry
  console.error("[api-error]", e);
  if (/INSUFFICIENT|insufficient/i.test(raw)) return { code: "INSUFFICIENT_FUNDS", message: "Insufficient funds for this transaction." };
  if (/VALIDATION_REQUIRED/i.test(raw)) return { code: "VALIDATION_REQUIRED", message: "Validation is required before this action can complete." };
  if (/UNAUTHORIZED|not control|403/i.test(raw)) return { code: "UNAUTHORIZED", message: "You don't have permission for this action." };
  return { code: "UNKNOWN", message: "Something went wrong. Please try again." };
}
