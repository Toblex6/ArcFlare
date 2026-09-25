// src/lib/config/network.ts
//
// AUTHORITATIVE Arc network configuration — the single source of truth for
// every network-specific value in production code (Phase 1 mainnet-readiness
// refactor). Previously these values were duplicated/hardcoded across
// ~50 production call sites (chainId 5042002, "ARC-TESTNET", testnet RPCs,
// Arcscan URLs, Gateway/Iris URLs, CCTP domain + MessageTransmitter, x402
// network/verifier, USDC/EURC/ERC-8183 addresses).
//
// Environments:
//   - "testnet" (default): Arc Testnet. Values below are the exact values
//     already live in this repository (verified, unchanged behavior).
//   - "mainnet": Arc Mainnet (production target). NO mainnet deployment
//     addresses are known in this repository, so EVERY mainnet value is a
//     required ARC_MAINNET_* environment input — EXCEPT
//     ARC_MAINNET_ERC8183_ADDRESS (external protocol dependency with no
//     verified mainnet address; optional, null when unset, per-feature
//     fail-closed via requireErc8183Address()). Selecting mainnet with a
//     missing REQUIRED value FAILS CLOSED (throws) — it never silently
//     inherits a testnet value.
//
// Selection: ARC_NETWORK (server) or NEXT_PUBLIC_ARC_NETWORK (browser).
// Unset (or any value other than "mainnet") => testnet. Testnet never
// requires mainnet-only variables.
//
// No secrets live in this module — only network topology + public contract
// addresses. This module is client-safe (no node-only imports; the viem
// import below is type-only and erased at build time).
import type { Chain } from "viem";

export type ArcNetworkName = "testnet" | "mainnet";

export interface ArcNetworkConfig {
  /** "testnet" | "mainnet" */
  name: ArcNetworkName;
  /** Arc EVM chain ID (testnet: 5042002) */
  chainId: number;
  /** EIP-155 identifier, e.g. "eip155:5042002" */
  eip155: string;
  /** Circle Developer-Controlled Wallets blockchain identifier */
  circleBlockchain: string;
  /** Primary JSON-RPC endpoint */
  primaryRpc: string;
  /** Fallback RPCs, primary-first order preserved by callers */
  fallbackRpcs: string[];
  /** Block explorer base URL (no trailing slash), e.g. https://testnet.arcscan.app */
  explorerBaseUrl: string;
  /** Circle Gateway (x402 facilitator) base URL, e.g. https://gateway-api-testnet.circle.com */
  gatewayUrl: string;
  /** Circle CCTP Iris API base URL (V2 path), e.g. https://iris-api-sandbox.circle.com/v2 */
  irisApiUrl: string;
  /** CCTP V2 destination domain for Arc (testnet: 26) */
  cctpDomain: number;
  /** CCTP V2 MessageTransmitter on Arc */
  cctpMessageTransmitter: string;
  /** x402 payment network identifier (same shape as eip155) */
  x402Network: string;
  /** x402 GatewayWalletBatched verifying (batching) contract */
  x402VerifierContract: string;
  /** USDC (6-dec ERC-20 interface) on Arc */
  usdcAddress: string;
  /** EURC (6 decimals) on Arc */
  eurcAddress: string;
  /**
   * ERC-8183 AgenticCommerce contract on Arc — or null when unconfigured.
   * Testnet always carries the pinned reference implementation. Mainnet
   * carries the verified ARC_MAINNET_ERC8183_ADDRESS when set, otherwise
   * null: ERC-8183-dependent features fail closed per-feature (503) instead
   * of crashing the app, and NEVER fall back to the testnet address.
   */
  erc8183Address: string | null;
  /** WalletConnect chain identifier, e.g. "eip155:5042002" */
  walletConnectChainId: string;
}

// ─── Testnet: exact values already live in this repo (do not change) ─────────
// Sources: src/lib/wallet/chainClient.ts, src/lib/x402.ts, src/lib/cctp.ts,
// src/lib/wagmi.ts, src/lib/chains.ts, src/lib/tokens/supportedTokens.ts,
// src/lib/contracts/erc8183.ts, src/app/api/gateway/route.ts,
// src/app/api/x402/seller/balance/route.ts.
//
// The ERC-8183 testnet address is NOT repeated below: it is imported from the
// canonical src/lib/contracts/erc8183.ts pin (tests/erc8183-config-drift
// .test.mjs enforces that no other file inlines that literal). The binding is
// only read inside buildTestnetConfig(), so the import cycle (erc8183.ts →
// network.ts for the mainnet selector) is evaluation-safe in both directions.
import { AGENTIC_COMMERCE_CONTRACT } from "../contracts/erc8183";
const TESTNET_DEFAULTS = {
  chainId: 5042002,
  eip155: "eip155:5042002",
  circleBlockchain: "ARC-TESTNET",
  primaryRpc: "https://rpc.testnet.arc.network",
  fallbackRpcs: [
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
    "https://rpc.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
  ],
  explorerBaseUrl: "https://testnet.arcscan.app",
  gatewayUrl: "https://gateway-api-testnet.circle.com",
  irisApiUrl: "https://iris-api-sandbox.circle.com/v2",
  cctpDomain: 26,
  cctpMessageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  x402Network: "eip155:5042002",
  x402VerifierContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  usdcAddress: "0x3600000000000000000000000000000000000000",
  eurcAddress: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  walletConnectChainId: "eip155:5042002",
} as const;

function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildTestnetConfig(
  env: Record<string, string | undefined> = process.env
): ArcNetworkConfig {
  // Honor the pre-existing RPC overrides; everything else is the pinned default.
  const primaryRpc =
    readEnv(env, "ARC_TESTNET_RPC") ??
    readEnv(env, "NEXT_PUBLIC_ARC_RPC") ??
    TESTNET_DEFAULTS.primaryRpc;
  const extraFallbacks = splitList(readEnv(env, "ARC_TESTNET_RPC_FALLBACKS"));
  const fallbackRpcs = [...extraFallbacks, ...TESTNET_DEFAULTS.fallbackRpcs].filter(
    (u) => u !== primaryRpc
  );
  return {
    name: "testnet",
    chainId: TESTNET_DEFAULTS.chainId,
    eip155: TESTNET_DEFAULTS.eip155,
    circleBlockchain: TESTNET_DEFAULTS.circleBlockchain,
    primaryRpc,
    fallbackRpcs,
    explorerBaseUrl: TESTNET_DEFAULTS.explorerBaseUrl,
    gatewayUrl: TESTNET_DEFAULTS.gatewayUrl,
    irisApiUrl: TESTNET_DEFAULTS.irisApiUrl,
    cctpDomain: TESTNET_DEFAULTS.cctpDomain,
    cctpMessageTransmitter: TESTNET_DEFAULTS.cctpMessageTransmitter,
    x402Network: TESTNET_DEFAULTS.x402Network,
    x402VerifierContract: TESTNET_DEFAULTS.x402VerifierContract,
    usdcAddress: TESTNET_DEFAULTS.usdcAddress,
    eurcAddress: TESTNET_DEFAULTS.eurcAddress,
    erc8183Address: AGENTIC_COMMERCE_CONTRACT,
    walletConnectChainId: TESTNET_DEFAULTS.walletConnectChainId,
  };
}

// Every mainnet value is a required environment input — nothing is inherited
// from testnet. Missing values fail closed with an actionable error.
//
// EXCEPTION: ARC_MAINNET_ERC8183_ADDRESS is deliberately NOT in this list.
// ERC-8183 is an external protocol dependency with no verified mainnet
// address (2026-09-23 decision). Requiring it would refuse to boot the entire
// app on mainnet; instead it is optional (null when unset) and every
// ERC-8183-dependent feature fails closed individually via
// requireErc8183Address(). See erc8183Address docs on the interface above.
export const MAINNET_REQUIRED_VARS = [
  "ARC_MAINNET_CHAIN_ID",
  "ARC_MAINNET_CIRCLE_BLOCKCHAIN",
  "ARC_MAINNET_RPC_URL",
  "ARC_MAINNET_EXPLORER_URL",
  "ARC_MAINNET_GATEWAY_URL",
  "ARC_MAINNET_CCTP_IRIS_URL",
  "ARC_MAINNET_CCTP_DOMAIN",
  "ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER",
  "ARC_MAINNET_USDC_ADDRESS",
  "ARC_MAINNET_EURC_ADDRESS",
  "ARC_MAINNET_X402_VERIFIER",
] as const;

function buildMainnetConfig(
  env: Record<string, string | undefined> = process.env
): ArcNetworkConfig {
  const missing = MAINNET_REQUIRED_VARS.filter((k) => !readEnv(env, k));
  if (missing.length > 0) {
    throw new Error(
      "ARC_NETWORK=mainnet is selected but required mainnet configuration is missing: " +
        missing.join(", ") +
        ". Set each ARC_MAINNET_* variable explicitly — testnet values are never inherited. " +
        "See .env.example (ARC MAINNET section)."
    );
  }
  const chainId = Number(readEnv(env, "ARC_MAINNET_CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(
      `ARC_MAINNET_CHAIN_ID must be a positive integer (got "${env.ARC_MAINNET_CHAIN_ID}").`
    );
  }
  const cctpDomain = Number(readEnv(env, "ARC_MAINNET_CCTP_DOMAIN"));
  if (!Number.isInteger(cctpDomain) || cctpDomain < 0) {
    throw new Error(
      `ARC_MAINNET_CCTP_DOMAIN must be a non-negative integer (got "${env.ARC_MAINNET_CCTP_DOMAIN}").`
    );
  }
  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  for (const k of [
    "ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER",
    "ARC_MAINNET_USDC_ADDRESS",
    "ARC_MAINNET_EURC_ADDRESS",
    "ARC_MAINNET_X402_VERIFIER",
  ] as const) {
    const v = readEnv(env, k)!;
    if (!ADDRESS_RE.test(v)) {
      throw new Error(`${k} must be a 0x EVM address (got "${v}").`);
    }
  }
  // ERC-8183 is optional on mainnet (see MAINNET_REQUIRED_VARS comment):
  // validated when present, null when absent — never testnet-inherited.
  const erc8183Raw = readEnv(env, "ARC_MAINNET_ERC8183_ADDRESS");
  if (erc8183Raw !== undefined && !ADDRESS_RE.test(erc8183Raw)) {
    throw new Error(
      `ARC_MAINNET_ERC8183_ADDRESS must be a 0x EVM address (got "${erc8183Raw}") — or leave it unset for per-feature fail-closed.`
    );
  }
  const primaryRpc = readEnv(env, "ARC_MAINNET_RPC_URL")!;
  const extraFallbacks = splitList(readEnv(env, "ARC_MAINNET_RPC_FALLBACKS"));
  // Derived identifiers default from the configured chain ID (derivation, not
  // testnet inheritance) but remain explicitly overridable.
  const eip155 = readEnv(env, "ARC_MAINNET_EIP155") ?? `eip155:${chainId}`;
  return {
    name: "mainnet",
    chainId,
    eip155,
    circleBlockchain: readEnv(env, "ARC_MAINNET_CIRCLE_BLOCKCHAIN")!,
    primaryRpc,
    fallbackRpcs: extraFallbacks.filter((u) => u !== primaryRpc),
    explorerBaseUrl: readEnv(env, "ARC_MAINNET_EXPLORER_URL")!.replace(/\/+$/, ""),
    gatewayUrl: readEnv(env, "ARC_MAINNET_GATEWAY_URL")!.replace(/\/+$/, ""),
    irisApiUrl: readEnv(env, "ARC_MAINNET_CCTP_IRIS_URL")!.replace(/\/+$/, ""),
    cctpDomain,
    cctpMessageTransmitter: readEnv(env, "ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER")!,
    x402Network: readEnv(env, "ARC_MAINNET_X402_NETWORK") ?? eip155,
    x402VerifierContract: readEnv(env, "ARC_MAINNET_X402_VERIFIER")!,
    usdcAddress: readEnv(env, "ARC_MAINNET_USDC_ADDRESS")!,
    eurcAddress: readEnv(env, "ARC_MAINNET_EURC_ADDRESS")!,
    erc8183Address: erc8183Raw ?? null,
    walletConnectChainId:
      readEnv(env, "ARC_MAINNET_WALLETCONNECT_CHAIN_ID") ?? eip155,
  };
}

/** Which Arc network is selected. Anything other than "mainnet" => testnet. */
export function getArcNetworkName(
  env: Record<string, string | undefined> = process.env
): ArcNetworkName {
  const raw = (
    readEnv(env, "ARC_NETWORK") ??
    readEnv(env, "NEXT_PUBLIC_ARC_NETWORK") ??
    "testnet"
  ).toLowerCase();
  return raw === "mainnet" ? "mainnet" : "testnet";
}

let cachedName: ArcNetworkName | null = null;
let cachedConfig: ArcNetworkConfig | null = null;

/** Authoritative config for the selected environment (cached per process). */
export function getNetworkConfig(
  env: Record<string, string | undefined> = process.env
): ArcNetworkConfig {
  const name = getArcNetworkName(env);
  if (cachedConfig && cachedName === name && env === process.env) return cachedConfig;
  const cfg = name === "mainnet" ? buildMainnetConfig(env) : buildTestnetConfig(env);
  if (env === process.env) {
    cachedName = name;
    cachedConfig = cfg;
  }
  return cfg;
}

/** Test seam — clears the process cache (tests only). */
export function __resetNetworkConfigCacheForTests(): void {
  cachedName = null;
  cachedConfig = null;
}

/**
 * Startup validation for the network layer (called from walletEnvCheck).
 * Testnet: always ok (no mainnet vars required). Mainnet: every
 * ARC_MAINNET_* input must be present and well-formed — returns the errors
 * instead of throwing so the caller can aggregate them fail-closed.
 */
export function validateNetworkEnv(
  env: Record<string, string | undefined> = process.env
): string[] {
  if (getArcNetworkName(env) !== "mainnet") return [];
  try {
    buildMainnetConfig(env);
    return [];
  } catch (e: any) {
    return [e?.message ?? String(e)];
  }
}

// ─── ERC-8183 per-feature fail-closed ────────────────────────────────────────
// ERC-8183 is an EXTERNAL protocol dependency (FlareHQ only calls it, never
// deploys it) with no verified Arc Mainnet address (2026-09-23 decision).
// The address is therefore optional in mainnet config (null when unset) and
// every ERC-8183-dependent feature gates on requireErc8183Address(): set
// address → the verified value; unset → Erc8183UnavailableError, which route
// handlers translate to HTTP 503. There is no testnet fallback and no fake
// address anywhere in this path.

/** Thrown when a feature needs ERC-8183 but no address is configured. */
export class Erc8183UnavailableError extends Error {
  readonly code = "erc8183_unavailable";
  constructor(networkName: ArcNetworkName = getArcNetworkName()) {
    super(
      `ERC-8183 AgenticCommerce is not configured on ${networkName} — job, hiring, and procurement features are unavailable. ` +
        `Set ARC_MAINNET_ERC8183_ADDRESS to the verified mainnet protocol address to enable them; testnet addresses are never used.`
    );
    this.name = "Erc8183UnavailableError";
  }
}

/** True when the selected network has a configured ERC-8183 address. */
export function isErc8183Available(
  env: Record<string, string | undefined> = process.env
): boolean {
  return getNetworkConfig(env).erc8183Address !== null;
}

/**
 * The configured ERC-8183 address, or throws Erc8183UnavailableError.
 * Route handlers MUST call this (via erc8183AddressOr503) instead of reading
 * getNetworkConfig().erc8183Address directly, so mainnet stays fail-closed
 * per-feature instead of crashing on a null address.
 */
export function requireErc8183Address(
  env: Record<string, string | undefined> = process.env
): string {
  const cfg = getNetworkConfig(env);
  if (!cfg.erc8183Address) throw new Erc8183UnavailableError(cfg.name);
  return cfg.erc8183Address;
}

// ─── Convenience readers (all flow from getNetworkConfig) ───────────────────

/** All candidate RPC URLs, primary first (existing reliable-RPC order kept). */
export function getRpcUrls(
  env: Record<string, string | undefined> = process.env
): string[] {
  const cfg = getNetworkConfig(env);
  return [cfg.primaryRpc, ...cfg.fallbackRpcs];
}

export function explorerTxUrl(
  txHash: string,
  env: Record<string, string | undefined> = process.env
): string {
  return `${getNetworkConfig(env).explorerBaseUrl}/tx/${txHash}`;
}

export function explorerAddressUrl(
  address: string,
  env: Record<string, string | undefined> = process.env
): string {
  return `${getNetworkConfig(env).explorerBaseUrl}/address/${address}`;
}

/**
 * A viem-compatible Arc chain definition built from the selected config,
 * typed as viem `Chain` so existing typed call sites (public/wallet clients,
 * log decoding) keep their inference exactly as with the previous inline
 * `as const` literals. Mainnet values are runtime inputs, so the object is
 * built per call rather than pinned.
 */
export function getArcChain(
  env: Record<string, string | undefined> = process.env
): Chain {
  const cfg = getNetworkConfig(env);
  return {
    id: cfg.chainId,
    name: cfg.name === "mainnet" ? "Arc" : "Arc Testnet",
    nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
    rpcUrls: { default: { http: [cfg.primaryRpc] } },
    blockExplorers: { default: { name: "ArcScan", url: cfg.explorerBaseUrl } },
    testnet: cfg.name !== "mainnet",
  };
}
