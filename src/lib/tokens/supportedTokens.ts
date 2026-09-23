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
 * cirBTC VERIFIED the same way on 2026-09-16 (name="Circle Wrapped
 * Bitcoin", symbol="cirBTC", decimals=8):
 *   - cirBTC: 0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF, 8 decimals
 */

import { getNetworkConfig } from "@/lib/config/network";

export type SupportedSymbol = "USDC" | "EURC" | "CIRBTC";

export interface SupportedToken {
  symbol: SupportedSymbol;
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
  CIRBTC: {
    symbol: "CIRBTC",
    address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF", // verified on-chain 2026-09-16: name="Circle Wrapped Bitcoin" symbol=cirBTC decimals=8
    decimals: 8, // 8-decimal base units (satoshis of BTC) — never 6, never 18
  },
};

/**
 * Environment-selected address for a supported symbol. Testnet returns the
 * pinned table values above (unchanged); mainnet returns the required
 * ARC_MAINNET_USDC_ADDRESS / ARC_MAINNET_EURC_ADDRESS inputs (fail-closed
 * when absent — never testnet values). cirBTC is Arc Testnet only in this
 * release: mainnet selection refuses fail-closed rather than inheriting the
 * testnet address.
 */
function addressFor(symbol: SupportedSymbol): string {
  const net = getNetworkConfig();
  if (net.name === "mainnet") {
    if (symbol === "CIRBTC") {
      throw new Error("cirBTC is not configured for mainnet — Arc Testnet only in this release");
    }
    return symbol === "USDC" ? net.usdcAddress : net.eurcAddress;
  }
  const token = SUPPORTED_TOKENS[symbol];
  if (!token) throw new Error(`unsupported token: ${symbol}`);
  return token.address;
}

const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000";

export function getTokenBySymbol(symbol: SupportedSymbol): SupportedToken {
  const token = SUPPORTED_TOKENS[symbol];
  if (!token) throw new Error(`unsupported token: ${symbol}`);
  const address = addressFor(symbol);
  if (address === PLACEHOLDER_ADDRESS) {
    throw new Error(`${symbol} address is a placeholder — set the real Arc Testnet address in supportedTokens.ts before use`);
  }
  return { ...token, address };
}

export function getTokenByAddress(address: string): SupportedToken | undefined {
  const normalized = address.toLowerCase();
  // Match the environment-selected addresses first (mainnet-aware), then the
  // pinned testnet table. Symbols unconfigured for the selected network
  // (cirBTC on mainnet) are skipped — they must not break lookup for the
  // configured symbols (Tower comparison normalizes USDC/EURC on mainnet).
  for (const symbol of ["USDC", "EURC", "CIRBTC"] as const) {
    let selected: string;
    try {
      selected = addressFor(symbol);
    } catch {
      continue;
    }
    if (selected.toLowerCase() === normalized) {
      return { ...SUPPORTED_TOKENS[symbol]!, address: selected };
    }
  }
  return Object.values(SUPPORTED_TOKENS).find(t => t.address.toLowerCase() === normalized);
}

export function isSupportedToken(address: string): boolean {
  return getTokenByAddress(address) !== undefined;
}

export function getUsdcAddress(): string {
  return getTokenBySymbol("USDC").address;
}