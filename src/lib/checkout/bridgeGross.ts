/** Invoice dollars to 6-decimal base units. */
export function invoiceAmountBaseUnits(amount: number): bigint {
  const units = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('Invoice amount is outside the supported range.');
  return BigInt(units);
}

/** Gross up the shortfall using the estimated USDC fee plus a 10% fee margin. */
export function grossUpInvoiceAmount(shortfall: bigint, estimatedFee: bigint): bigint {
  if (shortfall <= 0n || estimatedFee < 0n) throw new Error('Invalid checkout bridge amount.');
  return shortfall + estimatedFee + (estimatedFee + 9n) / 10n;
}

/** Only Bridge Kit's USDC deductions count here. Source gas is paid separately. */
export function estimatedBridgeFee(fees: unknown): bigint {
  if (!Array.isArray(fees) || !fees.some((fee) => fee?.type === 'forwarder')) throw new Error('Forwarder fee quote is missing.');
  return fees.reduce((sum: bigint, fee: { token?: unknown; amount?: unknown } | null) => {
    if (fee?.token !== 'USDC' || typeof fee.amount !== 'string' || !/^\d{1,18}(?:\.\d{1,6})?$/.test(fee.amount)) {
      throw new Error('Invalid Bridge Kit USDC fee.');
    }
    const [whole, fraction = ''] = fee.amount.split('.');
    return sum + BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  }, 0n);
}

export function checkoutShortfall(invoice: bigint, credited: bigint): bigint {
  return invoice > credited ? invoice - credited : 0n;
}
