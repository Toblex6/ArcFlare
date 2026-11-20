import { formatUnits, parseUnits } from 'viem';

const decimals = 6;
// Preserve the previous app ceiling, including safe conversion to the DB's Float.
const ceiling = 10_000_000_000_000n;

function parse(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d{1,8}(\.\d{1,6})?$/.test(text)) return null;
  const units = parseUnits(text, decimals);
  return units > 0n && units <= ceiling ? units : null;
}

export function checkEscrowAmount(value: unknown, configured = process.env.ESCROW_MAX_AMOUNT_USDC) {
  const maximum = parse(configured ?? '50');
  if (maximum === null) return { error: 'Escrow amount limit is misconfigured.', status: 503 } as const;
  const units = typeof value === 'bigint' ? value : parse(value);
  if (units === null || units <= 0n) return { error: 'Amount must be a positive USDC decimal with up to 6 decimal places.', status: 400 } as const;
  if (units > maximum) return { error: `Escrow amount exceeds the ${formatUnits(maximum, decimals)} USDC maximum.`, status: 400 } as const;
  return { units, amountUSDC: Number(units) / 1_000_000 } as const;
}
