// src/lib/config/unitflow.ts
//
// Atomic UnitFlow V3 deployment configuration (UnitFlow Phase 2, Task A).
//
// The five UnitFlow addresses below are ONE deployment family and must never
// be mixed with the dead alternate deployment set published in the old
// UnitFlowV3-contract repo README (different Factory/Quoter with no relevant
// pools/liquidity — proven dead, never referenced here).
//
// Pattern follows src/lib/config/network.ts:
//   - "testnet" (default): pinned values verified live against Arc Testnet
//     (chain 5042002) on 2026-09-12 — Factory.getPool + Quoter
//     quoteExactInputSingle + UniversalRouter.execute probed via RPC; WUSDC
//     identity/decimals read on-chain; Gate C mined tx 0xf23751f0… decoded.
//   - "mainnet": every address is a required UNITFLOW_MAINNET_* environment
//     input. Selecting mainnet with a missing/malformed value FAILS CLOSED —
//     it never inherits testnet values and never falls back to any alternate
//     deployment.
// Selection reuses getArcNetworkName() — no second network switch is
// introduced here. No secrets live in this module (public contract addresses
// only); client-safe (no node-only imports).

import { getArcNetworkName } from './network';

/** One UnitFlow V3 deployment family — always used atomically. */
export interface UnitFlowV3Deployment {
  /** "testnet" | "mainnet" (mirrors the Arc network selection). */
  name: 'testnet' | 'mainnet';
  /** Arc EVM chain id (testnet: 5042002). */
  chainId: number;
  /** V3 Factory (docs deployment; getPool-validated live). */
  factory: string;
  /** V3 Quoter (quoteExactInputSingle interface proven live). */
  quoter: string;
  /** UniversalRouter entry point (execute() proven live in Gate C). */
  universalRouter: string;
  /** Shared Permit2 (approve/allowance selectors verified in bytecode). */
  permit2: string;
  /** WUSDC (Wrapped USDC, WETH9-style deposit/withdraw). */
  wusdc: string;
}

/**
 * WUSDC decimals — read live on-chain (name=Wrapped USDC, symbol=WUSDC,
 * decimals=18). ArcFlare's canonical USDC view is 6 decimals, so the USDC leg
 * rescales by 1e12 between canonical base units and WUSDC swap units.
 */
export const UNITFLOW_WUSDC_DECIMALS = 18;

/** Canonical stable decimals for the EURC leg (matches normalize.ts). */
export const UNITFLOW_EURC_DECIMALS = 6;

// ─── Testnet: verified deployment family (do not change) ────────────────────
// Sources: docs.unitflow.finance/docs/dev/contracts + /docs/versions/v3 +
// /docs/dev/universal-router, verified live 2026-09-12:
//   Factory.getPool(WUSDC, EURC, 100) -> 0xe8f7… (liquidity 1.7e17)
//   Quoter.quoteExactInputSingle(WUSDC, EURC, 100, 1e16, 0) -> 8037
//   Gate C execute() tx 0xf23751f0… (commands 0x00, 5-param tuple, fee 100)
const TESTNET_DEPLOYMENT = {
  name: 'testnet',
  chainId: 5042002,
  factory: '0xAb6A8AAb7d490007634ef59d424b5d89688a1971',
  quoter: '0x121aeB6DEf00F6F67665008CaC1C19805886ed1a',
  universalRouter: '0xEaF3195bE51861632cd32850973C9515DA48e76F',
  permit2: '0x4ce562F687d0Ced27b79Ba51d79B63BD978F7F48',
  wusdc: '0x911b4000D3422F482F4062a913885f7b035382Df',
} as const satisfies Omit<UnitFlowV3Deployment, 'name'> & { name: 'testnet' };

// Every mainnet address is a required environment input — nothing is inherited
// from testnet and there is no fallback to any alternate deployment set.
export const UNITFLOW_MAINNET_REQUIRED_VARS = [
  'UNITFLOW_MAINNET_FACTORY',
  'UNITFLOW_MAINNET_QUOTER',
  'UNITFLOW_MAINNET_UNIVERSAL_ROUTER',
  'UNITFLOW_MAINNET_PERMIT2',
  'UNITFLOW_MAINNET_WUSDC',
] as const;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function buildMainnetDeployment(env: Record<string, string | undefined>): UnitFlowV3Deployment {
  const missing = UNITFLOW_MAINNET_REQUIRED_VARS.filter((k) => !readEnv(env, k));
  if (missing.length > 0) {
    throw new Error(
      'ARC_NETWORK=mainnet is selected but required UnitFlow deployment configuration is missing: ' +
        missing.join(', ') +
        '. Set each UNITFLOW_MAINNET_* variable explicitly — testnet values are never inherited.'
    );
  }
  const get = (k: (typeof UNITFLOW_MAINNET_REQUIRED_VARS)[number]): string => {
    const v = readEnv(env, k)!;
    if (!ADDRESS_RE.test(v)) {
      throw new Error(`${k} must be a 0x EVM address (got "${v}").`);
    }
    return v;
  };
  const chainIdRaw = readEnv(env, 'UNITFLOW_MAINNET_CHAIN_ID') ?? '';
  const chainId = chainIdRaw === '' ? 0 : Number(chainIdRaw);
  if (chainIdRaw !== '' && (!Number.isInteger(chainId) || chainId <= 0)) {
    throw new Error(`UNITFLOW_MAINNET_CHAIN_ID must be a positive integer (got "${chainIdRaw}").`);
  }
  return {
    name: 'mainnet',
    // 0 = unconfigured chain id only when the operator did not supply one;
    // the addresses above are still mandatory and fail closed. Callers that
    // need a chain id must pass UNITFLOW_MAINNET_CHAIN_ID explicitly.
    chainId,
    factory: get('UNITFLOW_MAINNET_FACTORY'),
    quoter: get('UNITFLOW_MAINNET_QUOTER'),
    universalRouter: get('UNITFLOW_MAINNET_UNIVERSAL_ROUTER'),
    permit2: get('UNITFLOW_MAINNET_PERMIT2'),
    wusdc: get('UNITFLOW_MAINNET_WUSDC'),
  };
}

/**
 * Atomic UnitFlow V3 deployment for the selected Arc network. Testnet returns
 * the pinned verified family; mainnet requires explicit env inputs and fails
 * closed otherwise. Never mixes families.
 */
export function getUnitFlowV3Deployment(
  env: Record<string, string | undefined> = process.env
): UnitFlowV3Deployment {
  if (getArcNetworkName(env) === 'mainnet') return buildMainnetDeployment(env);
  return { ...TESTNET_DEPLOYMENT };
}

/** Fail-closed assertion that a deployment carries five well-formed addresses. */
export function assertUnitFlowDeploymentComplete(d: UnitFlowV3Deployment): void {
  for (const k of ['factory', 'quoter', 'universalRouter', 'permit2', 'wusdc'] as const) {
    const v = (d as any)?.[k];
    if (typeof v !== 'string' || !ADDRESS_RE.test(v)) {
      throw new Error(
        `[unitflow-v3] deployment address missing or malformed: ${k} — refusing to build execution.`
      );
    }
  }
}
