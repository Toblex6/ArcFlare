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
 * when absent — never testnet values) and the docs-pinned mainnet cirBTC
 * address below (optional ARC_MAINNET_CIRBTC_ADDRESS override, fail-closed
 * when malformed — never the testnet cirBTC pin).
 */
export const MAINNET_CIRBTC_PIN =
  "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0"; // docs.arc.io/arc/references/contract-addresses (mainnet cirBTC, 8 decimals) — verified live 2026-09-30: name="Circle Wrapped Bitcoin" symbol=cirBTC decimals=8

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Clean "not supported on this network" signal (never a 500). Balance and
 * swap routes map this to a 4xx with code TOKEN_NOT_SUPPORTED_ON_NETWORK;
 * genuine RPC/DB failures keep their 500.
 */
export class TokenNotSupportedOnNetworkError extends Error {
  readonly code = "TOKEN_NOT_SUPPORTED_ON_NETWORK";
  readonly status = 400;
  constructor(symbol: string, network: string) {
    super(`${symbol} is not supported on ${network} — no token configuration exists for this network.`);
    this.name = "TokenNotSupportedOnNetworkError";
  }
}

/** True for the clean not-supported signal (typed error or legacy message). */
export function isTokenNotSupportedOnNetwork(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  if (anyErr.code === "TOKEN_NOT_SUPPORTED_ON_NETWORK") return true;
  const msg = typeof anyErr.message === "string" ? anyErr.message : "";
  return /not configured for .*mainnet|not supported on .*network/i.test(msg);
}

function addressFor(symbol: SupportedSymbol): string {
  const net = getNetworkConfig();
  if (net.name === "mainnet") {
    if (symbol === "CIRBTC") {
      // Mainnet cirBTC EXISTS (docs.arc.io, live pools on the UnitFlow
      // mainnet factory) — the old "testnet only" refusal was the Swap-page
      // 500. Default is the docs pin above (a documented public address, not
      // testnet inheritance); an explicit override is validated fail-closed.
      const raw = (process.env.ARC_MAINNET_CIRBTC_ADDRESS ?? "").trim();
      const addr = raw === "" ? MAINNET_CIRBTC_PIN : raw;
      if (!ADDRESS_RE.test(addr)) {
        throw new Error(
          `ARC_MAINNET_CIRBTC_ADDRESS must be a 0x EVM address (got "${raw}").`
        );
      }
      return addr;
    }
    return symbol === "USDC" ? net.usdcAddress : net.eurcAddress;
  }
  const token = SUPPORTED_TOKENS[symbol];
  if (!token) throw new TokenNotSupportedOnNetworkError(symbol, net.name);
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
  // NETWORK ISOLATION (pre-mainnet fix): on mainnet the testnet-pinned table
  // below MUST NOT be consulted — a mainnet path resolving a testnet token
  // address would silently use testnet configuration, violating the hard
  // invariant "no mainnet path may silently use testnet configuration."
  // Testnet behavior is unchanged (falls through to the pinned table).
  if (getNetworkConfig().name === "mainnet") {
    return undefined;
  }
  return Object.values(SUPPORTED_TOKENS).find(t => t.address.toLowerCase() === normalized);
}

export function isSupportedToken(address: string): boolean {
  return getTokenByAddress(address) !== undefined;
}

export function getUsdcAddress(): string {
  return getTokenBySymbol("USDC").address;
}