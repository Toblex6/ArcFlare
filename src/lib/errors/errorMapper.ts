// src/lib/errors/errorMapper.ts
// Shared error mappers: server/API + wallet. Wallet mapping re-exports from
// the wallet-specific module so imports stay single-sourced.

export type FriendlyCode = "INSUFFICIENT_FUNDS" | "VALIDATION_REQUIRED" | "UNAUTHORIZED" | "UNKNOWN";

export function mapApiError(e: any): { code: FriendlyCode; message: string } {
  const raw = String(e?.message ?? e ?? "");
  // preserve detail in console/Sentry
  console.error("[api-error]", e);
  if (/insufficient|outoffunds|out of funds|gas required exceeds allowance/i.test(raw)) return { code: "INSUFFICIENT_FUNDS", message: "Insufficient funds for this transaction." };
  if (/VALIDATION_REQUIRED/i.test(raw)) return { code: "VALIDATION_REQUIRED", message: "Validation is required before this action can complete." };
  if (/UNAUTHORIZED|not control|403/i.test(raw)) return { code: "UNAUTHORIZED", message: "You don't have permission for this action." };
  return { code: "UNKNOWN", message: "Something went wrong. Please try again." };
}

// Re-export wallet mapper so callers can import from a single error entrypoint
export { mapWalletError, friendlyWalletError, isUserRejection } from '@/lib/wallet/walletErrors';
export type { WalletErrorKind } from '@/lib/wallet/walletErrors';
