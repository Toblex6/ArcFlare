// src/lib/checkout/bridgeGross.ts
//
// Pure checkout cross-chain gross-up math. Kept free of env/DB/RPC so the
// adversarial cases run without funds.
//
// CCTP V2 can deduct a relayer/fast-transfer fee from the gross burn before
// crediting Arc. The payer must therefore burn MORE than the invoice so the
// merchant's mint credit is still >= the invoice amount. The buffer is a
// configured basis-point add-on, never a client-supplied amount:
//
//   gross = invoice + ceil(invoice * feeBps / 10_000)
//
// and the invoice is marked paid only when the measured Arc credit is
// >= the invoice amount (see the checkout complete route).

export const DEFAULT_CHECKOUT_BRIDGE_FEE_BPS = 100; // 1%
export const MAX_CHECKOUT_BRIDGE_FEE_BPS = 1000; // 10%

export function parseCheckoutBridgeFeeBps(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHECKOUT_BRIDGE_FEE_BPS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("ARC_CHECKOUT_BRIDGE_FEE_BPS must be an integer number of basis points.");
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CHECKOUT_BRIDGE_FEE_BPS) {
    throw new Error(`ARC_CHECKOUT_BRIDGE_FEE_BPS must be between 0 and ${MAX_CHECKOUT_BRIDGE_FEE_BPS}.`);
  }
  return value;
}

/** Invoice dollars → 6-decimal base units. Rejects non-finite/non-positive. */
export function invoiceAmountBaseUnits(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invoice amount must be a positive number.");
  const units = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error("Invoice amount is outside the supported range.");
  return BigInt(units);
}

/** Gross burn amount that covers the configured bridge-fee buffer. */
export function grossUpInvoiceAmount(invoiceBaseUnits: bigint, feeBps: number): bigint {
  if (invoiceBaseUnits <= 0n) throw new Error("Invoice amount must be positive.");
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > MAX_CHECKOUT_BRIDGE_FEE_BPS) {
    throw new Error("Bridge fee buffer is outside the supported range.");
  }
  if (feeBps === 0) return invoiceBaseUnits;
  const bps = BigInt(feeBps);
  const buffer = (invoiceBaseUnits * bps + 9_999n) / 10_000n; // ceil
  return invoiceBaseUnits + buffer;
}

/** True when the measured Arc credit satisfies the invoice. */
export function creditSatisfiesInvoice(actualBaseUnits: bigint, invoiceBaseUnits: bigint): boolean {
  return actualBaseUnits >= invoiceBaseUnits;
}
