// src/lib/config/unitflow.ts
//
// Atomic UnitFlow V3 deployment configuration (UnitFlow Phase 2, Task A;
// Arc Mainnet family wired in the UnitFlowV3+Tower mainnet stage).
//
// The testnet UnitFlow addresses below are ONE deployment family and must
// never be mixed with the dead alternate deployment set published in the old
// UnitFlowV3-contract repo README (different Factory/Quoter with no relevant
// pools/liquidity — proven dead, never referenced here).
//
// Pattern follows src/lib/config/network.ts:
//   - "testnet" (default): pinned values verified live against Arc Testnet
//     (chain 5042002) on 2026-09-12 — Factory.getPool + Quoter
//     quoteExactInputSingle + UniversalRouter.execute probed via RPC; WUSDC
//     identity/decimals read on-chain; Gate C mined tx 0xf23751f0… decoded.
//   - "mainnet": the V3 core family (Factory/Quoter/Router/PositionManager/
//     Multicall/TickLens/descriptors/Migrator) is pinned to the SUPPLIED Arc
//     Mainnet deployment below (chain 5042); the three executor-side inputs
//     (UniversalRouter/Permit2/WUSDC) stay required UNITFLOW_MAINNET_*
//     environment values. Selecting mainnet with a missing/malformed executor
//     value FAILS CLOSED — it never inherits testnet values and never falls
//     back to any alternate deployment.
// Selection reuses getArcNetworkName() — no second network switch is
// introduced here. No secrets live in this module (public contract addresses
// only); client-safe (no node-only imports).

import { getArcNetworkName } from './network';

/** One UnitFlow V3 deployment family — always used atomically. */
export interface UnitFlowV3Deployment {
  /** "testnet" | "mainnet" (mirrors the Arc network selection). */
  name: 'testnet' | 'mainnet';
  /** Arc EVM chain id (testnet: 5042002; mainnet: 5042). */
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
  /**
   * Full V3 core family (mainnet only — supplied Arc Mainnet deployment;
   * absent on testnet where these periphery addresses were never pinned).
   * Execution/verification consume factory/quoter/universalRouter/permit2/
   * wusdc above; these are exposed atomically for future wiring (position
   * management, multicall reads) — never mixed across networks.
   */
  v3Router?: string;
  positionManager?: string;
  multicall?: string;
  tickLens?: string;
  nftDescriptor?: string;
  positionDescriptor?: string;
  migrator?: string;
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

// ─── Mainnet: supplied Arc Mainnet V3 core family (pinned, not env-derived) ──
// Source: FlareHQ mainnet integration handoff (supplied, not redeployed by
// us). Provenance: claimed as the deployed + verified UnitFlow V3 set on Arc
// Mainnet (chain 5042). Live bytecode verified 2026-09-23 via
// scripts/verify-unitflow-mainnet-bytecode.mjs against
// https://rpc.mainnet.arc.io (chainId 0x13b2 = 5042): all 9 addresses carry
// bytecode, and Factory (24535 bytes) + Quoter (3847 bytes) match the
// testnet deployments byte-for-byte in size — same compiled contracts.
// Bytecode presence is NOT an interface/liquidity audit: no quoter/pool
// validation and no real mainnet swap run in this stage (NEXT stage review).
//
// The supplied UnitFlowV3Router (0x6fD8…) is the V3 SwapRouter — it is NOT
// the Permit2-based UniversalRouter executor whose execute(bytes,bytes[],
// uint256) entry point was proven on testnet (Gate C). It is therefore
// exposed as v3Router (future wiring) and NEVER aliased to universalRouter.
// Likewise no audited mainnet Permit2 / WUSDC values were supplied, so the
// three executor-side inputs below stay required UNITFLOW_MAINNET_* env
// values and mainnet execution stays fail-closed until they are set.
export const UNITFLOW_MAINNET_CHAIN_ID_PIN = 5042;

export const MAINNET_V3_FAMILY = {
  factory: '0x5bfBCeb73d39F722B1cB83fD2F11736b28c1Be6d',
  quoter: '0x5AF6E89F0960Ff375AF84d9911D8153ef6240E34',
  v3Router: '0x6fD8351b9596C1F0b2f2479BfA6A171cb3d0f410',
  positionManager: '0x300F5f2861eF0d9D3c6B812797C0A4c8b15C86a8',
  multicall: '0xc9E1780bA34698C1067EA6B2fcF78f111a5F110b',
  tickLens: '0x20Df732207340234E490a1e686A3A8055AF59b4e',
  nftDescriptor: '0x9Ca8e324380Aa2E80011A16C4d684366E47d4Ab4',
  positionDescriptor: '0x5Bc0735F5D806C184EDE0A7731632F7c491B3B02',
  migrator: '0x36E9b24b9CF39c4C7069B75f01FA0419547F977a',
} as const;

// Executor-side inputs with NO verified mainnet value supplied — required
// environment inputs on mainnet, fail-closed when absent. Nothing is
// inherited from testnet and there is no fallback to any alternate set.
export const UNITFLOW_MAINNET_REQUIRED_VARS = [
  'UNITFLOW_MAINNET_UNIVERSAL_ROUTER',
  'UNITFLOW_MAINNET_PERMIT2',
  'UNITFLOW_MAINNET_WUSDC',
] as const;

// Factory/Quoter accept an explicit operator override but default to the
// pinned mainnet family above (never testnet). Overrides are validated as
// 0x addresses and fail closed when malformed.
export const UNITFLOW_MAINNET_OPTIONAL_VARS = [
  'UNITFLOW_MAINNET_FACTORY',
  'UNITFLOW_MAINNET_QUOTER',
] as const;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function readAddressOrPin(
  env: Record<string, string | undefined>,
  key: (typeof UNITFLOW_MAINNET_OPTIONAL_VARS)[number],
  pin: string
): string {
  const raw = readEnv(env, key);
  if (raw === undefined) return pin;
  if (!ADDRESS_RE.test(raw)) {
    throw new Error(`${key} must be a 0x EVM address (got "${raw}").`);
  }
  return raw;
}

function buildMainnetDeployment(env: Record<string, string | undefined>): UnitFlowV3Deployment {
  const missing = UNITFLOW_MAINNET_REQUIRED_VARS.filter((k) => !readEnv(env, k));
  if (missing.length > 0) {
    throw new Error(
      'ARC_NETWORK=mainnet is selected but required UnitFlow deployment configuration is missing: ' +
        missing.join(', ') +
        '. Set each UNITFLOW_MAINNET_* variable explicitly — testnet values are never inherited. ' +
        '(No verified mainnet UniversalRouter/Permit2/WUSDC values have been supplied; mainnet execution stays fail-closed until they are.)'
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
  // Default is the pinned Arc Mainnet chain id (docs.arc.io, confirmed in
  // .env.example 2026-09-22) — derivation from a pin, not testnet
  // inheritance. Explicitly overridable; keep aligned with
  // ARC_MAINNET_CHAIN_ID when overriding.
  const chainId = chainIdRaw === '' ? UNITFLOW_MAINNET_CHAIN_ID_PIN : Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`UNITFLOW_MAINNET_CHAIN_ID must be a positive integer (got "${chainIdRaw || '(default pin)'}").`);
  }
  return {
    name: 'mainnet',
    chainId,
    factory: readAddressOrPin(env, 'UNITFLOW_MAINNET_FACTORY', MAINNET_V3_FAMILY.factory),
    quoter: readAddressOrPin(env, 'UNITFLOW_MAINNET_QUOTER', MAINNET_V3_FAMILY.quoter),
    universalRouter: get('UNITFLOW_MAINNET_UNIVERSAL_ROUTER'),
    permit2: get('UNITFLOW_MAINNET_PERMIT2'),
    wusdc: get('UNITFLOW_MAINNET_WUSDC'),
    v3Router: MAINNET_V3_FAMILY.v3Router,
    positionManager: MAINNET_V3_FAMILY.positionManager,
    multicall: MAINNET_V3_FAMILY.multicall,
    tickLens: MAINNET_V3_FAMILY.tickLens,
    nftDescriptor: MAINNET_V3_FAMILY.nftDescriptor,
    positionDescriptor: MAINNET_V3_FAMILY.positionDescriptor,
    migrator: MAINNET_V3_FAMILY.migrator,
  };
}

/**
 * Atomic UnitFlow V3 deployment for the selected Arc network. Testnet returns
 * the pinned verified family; mainnet returns the pinned mainnet V3 core
 * family (Factory/Quoter/Router/PositionManager/Multicall/TickLens/
 * descriptors/Migrator + chain 5042) with the three executor-side inputs
 * (UniversalRouter/Permit2/WUSDC) resolved from required env vars — mainnet
 * fails closed while any of those are absent. Never mixes families.
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
