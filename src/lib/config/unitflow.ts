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
//     Mainnet deployment below (chain 5042). Mainnet executes DIRECTLY
//     against the pinned UnitFlowV3Router via standard Uniswap V3
//     exactInputSingle calls (no UniversalRouter needed — see executor note
//     below); the USDC leg uses Arc's canonical native USDC ERC-20 interface
//     (no WUSDC wrapper exists on Arc — docs.arc.io/contract-addresses).
//     Mainnet therefore initializes WITHOUT any UNITFLOW_MAINNET_* executor
//     env values; Factory/Quoter accept an explicit override, Permit2/USDC-leg
//     accept one. Selecting mainnet with a malformed override FAILS CLOSED —
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
  /** Arc EVM chain id (testnet: 5042002; mainnet: 5042). */
  chainId: number;
  /** V3 Factory (docs deployment; getPool-validated live). */
  factory: string;
  /** V3 Quoter (quoteExactInputSingle interface proven live). */
  quoter: string;
  /**
   * Executor entry point for THIS network (single authority consumed via
   * getUnitFlowExecutor() — never branched on by callers):
   *   - testnet: the UniversalRouter (execute() proven live in Gate C);
   *   - mainnet: the pinned UnitFlowV3Router (direct V3 exactInputSingle —
   *     no UniversalRouter exists on mainnet, none is needed).
   */
  universalRouter: string;
  /**
   * Direct V3 SwapRouter address when the executor IS the V3 router
   * (mainnet: pinned 0x6fD8…; testnet: absent — the testnet executor is the
   * UniversalRouter, whose V3-router internals were never pinned).
   */
  v3Router?: string;
  /** Shared Permit2 (approve/allowance selectors verified in bytecode). */
  permit2: string;
  /**
   * USDC-leg swap token for THIS network (single authority consumed via
   * unitFlowSwapLeg()/resolveUnitFlowUsdcSwapToken() — never branched on by
   * callers):
   *   - testnet: WUSDC (Wrapped USDC, WETH9-style deposit/withdraw);
   *   - mainnet: Arc's canonical native USDC ERC-20 interface (no WUSDC
   *     wrapper exists on Arc — docs.arc.io/contract-addresses).
   */
  wusdc: string;
  /**
   * Full V3 core family (mainnet only — supplied Arc Mainnet deployment;
   * absent on testnet where these periphery addresses were never pinned).
   * Execution/verification consume factory/quoter plus the network executor
   * (universalRouter field: testnet UniversalRouter, mainnet V3Router) and
   * the network USDC-leg token (wusdc field: testnet WUSDC, mainnet canonical
   * USDC); these are exposed atomically for future wiring (position
   * management, multicall reads) — never mixed across networks.
   */
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
// DETERMINATION (2026-09-24 — UniversalRouter vs UnitFlowV3Router):
// No UniversalRouter is needed on mainnet, and none exists there. Evidence:
//   (a) UnitFlow's own source (UnitFlow-Finance/UnitFlowV3-contract, main
//       branch README: "Forked from Uniswap V3, using native Arc USDC") is a
//       straight V3 core+periphery fork — contracts/core +
//       contracts/periphery (PositionManager, UnitFlowV3Router, Quoter,
//       TickLens, Multicall, Migrator, descriptors). No UniversalRouter
//       contract exists anywhere in that repo.
//   (b) UnitFlow docs (docs.unitflow.finance/docs/dev/contracts, Arc Mainnet
//       chain 5042) list exactly ONE swap executor: "UnitFlowV3Router —
//       Executes V3 swaps — 0x6fD8351b9596C1F0b2f2479BfA6A171cb3d0f410".
//       No UniversalRouter appears on that page or on /docs/versions/v3.
//   (c) UnitFlowV3Router IS UnitFlowV3Router (contract UnitFlowV3Router is
//       ISwapRouter …, raw source verified): it exposes exactInputSingle(
//       ExactInputSingleParams) + exactInput(ExactInputParams) directly —
//       single-hop AND multi-hop exact-input swaps with NO Permit2, NO
//       command bytes, NO wrapper step. payer is fixed to msg.sender and the
//       pool pulls the input via transferFrom through the swap callback, so
//       the ONLY pre-approval is token → V3Router directly.
// Therefore the fail-closed UNITFLOW_MAINNET_UNIVERSAL_ROUTER requirement was
// a wrong assumption (carried over from the testnet UniversalRouter proof),
// and mainnet executes direct V3 exactInputSingle against the pinned
// 0x6fD8… router. Testnet keeps its proven UniversalRouter path untouched.
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

// ─── Mainnet executor + token legs (no env required) ─────────────────────────
// Permit2 is deployed at the SAME keyless address on every EVM chain that
// carries it (Uniswap docs: 0x0000…22D4…78BA3 everywhere except zkSync),
// and Arc's official contract-addresses page pins exactly that address on
// BOTH Arc Mainnet and Arc Testnet ("Required for StableFX") — so mainnet
// Permit2 is the canonical pin, not an env input. (Kept for interface
// compatibility / future Permit2-based flows; the direct V3 path below does
// NOT route approvals through it.)
export const UNITFLOW_PERMIT2_PIN = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Arc has NO wrapped-USDC contract: the docs state verbatim "There is no
// wrapped USDC address on Arc" and "The wrapping step does not exist;
// protocols should use this address directly" — the native USDC ERC-20
// interface (same 0x3600…0000 address on mainnet and testnet, 6 decimals)
// serves the "wrapped native" role. The deployment's USDC-leg swap token is
// therefore resolved from the authoritative network config (ARC_MAINNET_* on
// mainnet, pinned 0x3600…0000 on testnet), with an explicit operator override
// available. The legacy UNITFLOW_MAINNET_WUSDC variable is RETIRED — it is
// ignored when set (never read) and absent from the required list — so no
// code path can treat WUSDC as a separate required mainnet address.

// Legacy fail-closed executor env list — RETIRED 2026-09-24 (see
// DETERMINATION above). Kept as an EMPTY export so existing imports keep
// compiling; mainnet initialization requires NONE of these.
export const UNITFLOW_MAINNET_REQUIRED_VARS = [] as const;

// Factory/Quoter accept an explicit operator override but default to the
// pinned mainnet family above (never testnet). Permit2 accepts an explicit
// operator override but defaults to the canonical keyless pin (same address
// on Arc mainnet + testnet). The USDC-leg swap token accepts an explicit
// operator override but defaults to the authoritative network config's USDC
// address (ARC_MAINNET_USDC_ADDRESS on mainnet, pinned 0x3600…0000 on
// testnet — never a WUSDC wrapper, which does not exist on Arc). Overrides
// are validated as 0x addresses and fail closed when malformed.
export const UNITFLOW_MAINNET_OPTIONAL_VARS = [
  'UNITFLOW_MAINNET_FACTORY',
  'UNITFLOW_MAINNET_QUOTER',
  'UNITFLOW_MAINNET_PERMIT2',
  'UNITFLOW_MAINNET_USDC',
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
  // Mainnet executor: direct V3 exactInputSingle against the pinned
  // UnitFlowV3Router — no UniversalRouter exists on mainnet and none is
  // needed (see DETERMINATION). The USDC-leg swap token is Arc's canonical
  // native USDC ERC-20 interface (no WUSDC wrapper on Arc). Permit2 defaults
  // to the canonical keyless pin (same address on Arc mainnet + testnet).
  // Malformed overrides fail closed; testnet values are never inherited and
  // there is no fallback to any alternate deployment.
  //
  // IMPORTANT: USDC-leg resolution must NOT import network.ts or
  // supportedTokens.ts here — unitflow.ts is imported BY network-adjacent
  // modules and a static import would risk an evaluation cycle. Only the
  // ARC_MAINNET_USDC_ADDRESS env input is read directly (it is the same
  // source buildMainnetConfig() in network.ts requires); when absent, the
  // canonical 0x3600…0000 pin is used (identical on Arc mainnet + testnet
  // per docs.arc.io/contract-addresses — a documented pin, not testnet
  // inheritance).
  const chainIdRaw = readEnv(env, 'UNITFLOW_MAINNET_CHAIN_ID') ?? '';
  // Default is the pinned Arc Mainnet chain id (docs.arc.io, confirmed in
  // .env.example 2026-09-22) — derivation from a pin, not testnet
  // inheritance. Explicitly overridable; keep aligned with
  // ARC_MAINNET_CHAIN_ID when overriding.
  const chainId = chainIdRaw === '' ? UNITFLOW_MAINNET_CHAIN_ID_PIN : Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`UNITFLOW_MAINNET_CHAIN_ID must be a positive integer (got "${chainIdRaw || '(default pin)'}").`);
  }
  const usdcRaw = readEnv(env, 'UNITFLOW_MAINNET_USDC') ?? readEnv(env, 'ARC_MAINNET_USDC_ADDRESS');
  const usdcSwap = usdcRaw ?? '0x3600000000000000000000000000000000000000';
  if (!ADDRESS_RE.test(usdcSwap)) {
    throw new Error(`UNITFLOW_MAINNET_USDC/ARC_MAINNET_USDC_ADDRESS must be a 0x EVM address (got "${usdcRaw}").`);
  }
  return {
    name: 'mainnet',
    chainId,
    factory: readAddressOrPin(env, 'UNITFLOW_MAINNET_FACTORY', MAINNET_V3_FAMILY.factory),
    quoter: readAddressOrPin(env, 'UNITFLOW_MAINNET_QUOTER', MAINNET_V3_FAMILY.quoter),
    // Executor IS the pinned V3 SwapRouter (direct exactInputSingle — no
    // UniversalRouter on mainnet). universalRouter keeps its field name so
    // every downstream consumer (execution identity, drift checks, stored
    // deploymentRouter bindings) works UNCHANGED — it now carries the V3
    // router on mainnet, the UniversalRouter on testnet. v3Router pins the
    // same address explicitly for direct-V3 call encoding.
    universalRouter: MAINNET_V3_FAMILY.v3Router,
    permit2: readAddressOrPin(env, 'UNITFLOW_MAINNET_PERMIT2', UNITFLOW_PERMIT2_PIN),
    // USDC leg: canonical native USDC ERC-20 interface (no WUSDC on Arc).
    // wusdc keeps its field name so every downstream consumer (swap legs,
    // wrap/unwrap gating, stored tokenInSwap/tokenOutSwap bindings) works
    // UNCHANGED — it now carries canonical USDC (6-dec, identity units) on
    // mainnet, WUSDC (18-dec) on testnet.
    wusdc: usdcSwap,
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
 * the pinned verified family (UniversalRouter executor, WUSDC USDC-leg);
 * mainnet returns the pinned mainnet V3 core family (Factory/Quoter/Router/
 * PositionManager/Multicall/TickLens/descriptors/Migrator + chain 5042) with
 * the executor set to the pinned UnitFlowV3Router (direct V3 exactInputSingle
 * — no UniversalRouter needed) and the USDC leg set to Arc's canonical
 * native USDC ERC-20 interface (no WUSDC wrapper on Arc). Mainnet
 * initializes with NO required env values; malformed overrides fail closed.
 * Never mixes families.
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
