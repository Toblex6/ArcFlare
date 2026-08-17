/**
 * supportedTokens.ts
 *
 * Central registry for tokens FlareHQ supports — the single source of truth
 * for token addresses/decimals, replacing the hardcoded ARC_USDC_ADDRESS
 * constant that was previously duplicated across x402JobPayment.ts,
 * payrollExecution.ts, circleProvider.ts, settlementRecovery.ts, etc.
 * Import from here instead of hardcoding an address.
 *
 * Addresses VERIFIED against the live Arc Testnet RPC (2026-08-16) by
 * calling name()/symbol()/decimals() directly on each contract:
 *   - USDC (ERC-20 interface of the native gas token): 0x3600…0000, 6 decimals
 *   - EURC: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a, 6 decimals
 */

export interface SupportedToken {
  symbol: "USDC" | "EURC";
  address: string;
  decimals: number;
}

export const SUPPORTED_TOKENS: Record<string, SupportedToken> = {
  USDC: {
    symbol: "USDC",
    address: "0x3600000000000000000000000000000000000000", // verified on-chain: name=USDC symbol=USDC decimals=6
    decimals: 6, // the ERC-20 interface uses 6 decimals (native gas token internally uses 18 — never use that here)
  },
  EURC: {
    symbol: "EURC",
    address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", // verified on-chain: name=EURC symbol=EURC decimals=6
    decimals: 6,
  },
};

const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000";

export function getTokenBySymbol(symbol: "USDC" | "EURC"): SupportedToken {
  const token = SUPPORTED_TOKENS[symbol];
  if (!token) throw new Error(`unsupported token: ${symbol}`);
  if (token.address === PLACEHOLDER_ADDRESS) {
    throw new Error(`${symbol} address is a placeholder — set the real Arc Testnet address in supportedTokens.ts before use`);
  }
  return token;
}

export function getTokenByAddress(address: string): SupportedToken | undefined {
  const normalized = address.toLowerCase();
  return Object.values(SUPPORTED_TOKENS).find(t => t.address.toLowerCase() === normalized);
}

export function isSupportedToken(address: string): boolean {
  return getTokenByAddress(address) !== undefined;
}

export function getUsdcAddress(): string {
  return getTokenBySymbol("USDC").address;
}