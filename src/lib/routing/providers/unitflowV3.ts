// src/lib/routing/providers/unitflowV3.ts
//
// UnitFlow V3 provider — Phase 2 (unsigned execution + pure verification).
//
// Deployment family (factory/quoter/executor/permit2/usdc-leg) lives ONLY
// in src/lib/config/unitflow.ts and is consumed atomically here — no address
// copies, no mixing with the dead alternate README deployment set.
//
// TWO EXECUTORS (network-selected, never mixed):
//   - testnet: UniversalRouter execute(bytes,bytes[],uint256) with a SINGLE
//     proven command 0x00 (V3_SWAP_EXACT_IN) + Permit2 pull. Pools are
//     WUSDC-denominated (18-dec, WETH9-style). USDC input wraps via a
//     SEPARATE unsigned WUSDC.deposit{value} step; execute() value is always
//     0. Rescale: canonical 6-dec USDC x 1e12 = 18-dec wrap/swap units.
//     Evidence: Gate C mined tx 0xf23751f0… (recipient = arbitrary merchant
//     EOA, payer pulled via Permit2 — selectors verified in bytecode).
//   - mainnet: UnitFlowV3Router exactInputSingle() DIRECTLY (standard Uniswap
//     V3 SwapRouter — contract UnitFlowV3Router is ISwapRouter …, raw source
//     verified; no UniversalRouter exists on mainnet, none is needed).
//     Pools are NATIVE-USDC-denominated (canonical 0x3600…0000, 6-dec —
//     docs.arc.io: "There is no wrapped USDC address on Arc … The wrapping
//     step does not exist"). payer is fixed to msg.sender (pool pulls input
//     via transferFrom through the swap callback), so the ONLY pre-approval
//     is token → V3Router directly (no Permit2 in the path). No wrap step,
//     no rescale, USDC legs are 6-dec identity throughout.
// Branching rule: every network difference flows from the deployment object
// (getUnitFlowExecutor() / resolveUnitFlowUsdcSwapToken() /
// usdcSwapDecimalsFor() below). Callers NEVER branch on deployment.name and
// NEVER hardcode a network token address.
//
// Tower execution remains quote-only; canonical routing is untouched.

import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
} from 'viem';
import { getNetworkConfig } from '../../config/network';
import {
  assertUnitFlowDeploymentComplete,
  getUnitFlowV3Deployment,
  type UnitFlowV3Deployment,
} from '../../config/unitflow';
import { getTokenBySymbol } from '../../tokens/supportedTokens';
import {
  getRoutingPublicClient,
  readWithRetry,
  ROUTING_OUT_FEE_BUFFER,
  ROUTING_QUOTE_TTL_MS,
  ROUTING_SLIPPAGE_BPS,
  routingError,
} from '../canonical';
import { discountForSlippage } from '../quoteMath';
import {
  notImplemented,
  type NormalizedProviderQuote,
  type QuoteContext,
  type SwapProvider,
  type UnsignedExecution,
} from './types';

// ─── Protocol constants (from UnitFlow V3 docs; not deployment addresses) ────
/** V3 fee tiers offered by the UnitFlow frontend (docs/versions/v3). */
export const UNITFLOW_V3_ALLOWED_FEES = [100, 500, 3000, 10000] as const;
/** Default fee tier for stable pairs (docs: 0.01% = 100). */
export const UNITFLOW_V3_DEFAULT_FEE = 100;
/** Proven deployed V3 exact-input command byte. */
export const UNITFLOW_V3_SWAP_EXACT_IN = '0x00' as const;
/** 6-dec canonical units -> 18-dec WUSDC/native units (TESTNET USDC leg only). */
export const UNITFLOW_6_TO_18_SCALE = 1_000_000_000_000n;
/** Zero address (no pool / no recipient). */
export const UNITFLOW_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// ─── Minimal verified ABIs ───────────────────────────────────────────────────
const FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }, { name: '', type: 'uint24' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const POOL_ABI = [
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** Proven live: quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96). */
export const UNITFLOW_V3_QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

const WUSDC_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

/**
 * Canonical WUSDC.withdraw(uint256) selector (WETH9-style unwrap, verified in
 * the deployed bytecode alongside deposit()). Exported so the swap service
 * and its tests decode/validate unwrap calldata against this one authority —
 * no selector copies elsewhere.
 */
export const UNITFLOW_WUSDC_WITHDRAW_SELECTOR = '0x2e1a7d4d' as const;

const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * Shared decode ABI for the proven execute(bytes,bytes[],uint256) entry
 * point. Exported for the swap application service (verify-onchain evidence
 * collection decodes mined tx calldata with this — the one ABI authority
 * stays here, no copies in service/route files).
 */
export const UNITFLOW_V3_ROUTER_ABI = UNIVERSAL_ROUTER_ABI;

/**
 * Direct-V3 SwapRouter ABI (mainnet executor): standard Uniswap V3
 * exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,
 * uint160)) — field order tokenIn/tokenOut/fee/recipient/deadline/amountIn/
 * amountOutMinimum/sqrtPriceLimitX96 per UnitFlow's ISwapRouter.sol (which is
 * Uniswap's ISwapRouter with UnitFlowV3* renames). Exported so the swap
 * service can decode mined direct-V3 calldata with this single authority.
 */
export const UNITFLOW_V3_DIRECT_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

// ─── Helpers (pure) ──────────────────────────────────────────────────────────
function isAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isZeroAddress(a: string): boolean {
  return a.toLowerCase() === UNITFLOW_ZERO_ADDRESS;
}

/**
 * Which swap executor this deployment uses. Mainnet executes DIRECTLY
 * against the pinned UnitFlowV3Router (deployment.v3Router set); testnet
 * executes via the UniversalRouter (no v3Router pinned). Single authority —
 * every executor-dependent branch below reads this, never deployment.name.
 */
export type UnitFlowExecutor = 'universal-router' | 'v3-direct';

export function getUnitFlowExecutor(deployment: UnitFlowV3Deployment): UnitFlowExecutor {
  return typeof (deployment as any)?.v3Router === 'string' &&
    /^0x[a-fA-F0-9]{40}$/.test((deployment as any).v3Router)
    ? 'v3-direct'
    : 'universal-router';
}

/**
 * USDC-leg swap decimals for THIS deployment: 18 on testnet (WUSDC), 6 on
 * mainnet (canonical native USDC — no wrapper on Arc). Single authority —
 * unit conversion below reads this, never deployment.name.
 */
export function usdcSwapDecimalsFor(deployment: UnitFlowV3Deployment): 18 | 6 {
  return getUnitFlowExecutor(deployment) === 'v3-direct' ? 6 : 18;
}

/**
 * Resolve the pool-side USDC token for a Quoter/Factory call. Mainnet pools
 * are native-USDC-denominated (canonical 0x3600…0000 via deployment.wusdc);
 * testnet pools are WUSDC-denominated. Never hardcodes an address — always
 * the deployment's own USDC-leg field.
 */
export function resolveUnitFlowUsdcSwapToken(deployment: UnitFlowV3Deployment): string {
  return deployment.wusdc;
}

/** Swap-leg view: what UnitFlow actually settles (USDC-leg 18/6-dec vs EURC 6-dec vs cirBTC 8-dec). */
export interface UnitFlowSwapLeg {
  symbol: 'USDC' | 'EURC' | 'CIRBTC';
  /** Address used inside the V3 path (USDC-leg token for the USDC leg, spot token otherwise). */
  swapAddress: string;
  /** Decimals of the swap token (18/6 for the USDC leg by network, 6 for EURC, 8 for cirBTC). */
  swapDecimals: number;
}

export function unitFlowSwapLeg(
  symbol: 'USDC' | 'EURC' | 'CIRBTC',
  deployment: UnitFlowV3Deployment
): UnitFlowSwapLeg {
  if (symbol === 'USDC') {
    return { symbol, swapAddress: resolveUnitFlowUsdcSwapToken(deployment), swapDecimals: usdcSwapDecimalsFor(deployment) };
  }
  if (symbol === 'CIRBTC') {
    // cirBTC pools settle the spot 8-dec token directly (no wrapped variant).
    return { symbol, swapAddress: getTokenBySymbol('CIRBTC').address, swapDecimals: 8 };
  }
  return { symbol, swapAddress: getTokenBySymbol('EURC').address, swapDecimals: 6 };
}

/**
 * Canonical base units -> swap-leg units. The USDC leg rescales 6 -> 18 on
 * TESTNET only (WUSDC); on mainnet the USDC leg is 6-dec identity (native
 * USDC). EURC/cirBTC legs are always identity. Deployment-aware — never
 * assumes one network.
 */
export function toSwapUnits(
  symbol: 'USDC' | 'EURC' | 'CIRBTC',
  canonical: bigint,
  deployment?: UnitFlowV3Deployment
): bigint {
  if (canonical <= 0n) throw routingError(400, '[unitflow-v3] input amount must be positive.');
  if (symbol !== 'USDC') return canonical;
  if (deployment && usdcSwapDecimalsFor(deployment) === 6) return canonical;
  return canonical * UNITFLOW_6_TO_18_SCALE;
}

/**
 * Slippage floor via the existing ArcFlare convention (quoteMath, pair-
 * agnostic bigint math — no second formula). The canonical out-fee buffer
 * (keyed by settlement symbol) is rescaled to swap-leg decimals.
 */
export function unitFlowMinOut(
  quotedSwap: bigint,
  slippageBps: number,
  outputSymbol: 'USDC' | 'EURC' | 'CIRBTC',
  outputSwapDecimals: number
): bigint {
  const base = ROUTING_OUT_FEE_BUFFER[outputSymbol];
  const buffer = outputSwapDecimals === 18 ? base * UNITFLOW_6_TO_18_SCALE : base;
  return discountForSlippage(quotedSwap, slippageBps, buffer);
}

/**
 * Encode the direct-V3 exactInputSingle params tuple for the mainnet
 * executor. Field order is the ISwapRouter struct order (verified against
 * UnitFlow's ISwapRouter.sol): tokenIn/tokenOut/fee/recipient/deadline/
 * amountIn/amountOutMinimum/sqrtPriceLimitX96. sqrtPriceLimitX96 is always 0
 * (no price limit — the Quoter-validated minOut is the floor).
 */
export function encodeV3DirectExactInputSingle(args: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: UNITFLOW_V3_DIRECT_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: args.tokenIn as `0x${string}`,
        tokenOut: args.tokenOut as `0x${string}`,
        fee: args.fee,
        recipient: args.recipient as `0x${string}`,
        deadline: args.deadline,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

/** Decoded direct-V3 exactInputSingle params (pure — no RPC). */
export interface DecodedV3DirectExactInputSingle {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}

export function decodeV3DirectExactInputSingle(data: unknown): DecodedV3DirectExactInputSingle {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data)) {
    throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: not hex.');
  }
  try {
    const decoded = decodeFunctionData({ abi: UNITFLOW_V3_DIRECT_ROUTER_ABI, data: data as `0x${string}` });
    if (decoded.functionName !== 'exactInputSingle') throw new Error('not exactInputSingle()');
    const [params] = decoded.args as unknown as [
      {
        tokenIn: string;
        tokenOut: string;
        fee: number;
        recipient: string;
        deadline: bigint;
        amountIn: bigint;
        amountOutMinimum: bigint;
        sqrtPriceLimitX96: bigint;
      }
    ];
    if (!isAddress(params.tokenIn) || !isAddress(params.tokenOut) || !isAddress(params.recipient)) {
      throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: addresses.');
    }
    return { ...params };
  } catch (e: any) {
    if (typeof e?.status === 'number') throw e;
    throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: undecodable.');
  }
}

// ─── buildExecution() ────────────────────────────────────────────────────────
export interface UnitFlowV3BuildInput {
  inputSymbol: 'USDC' | 'EURC' | 'CIRBTC';
  outputSymbol: 'USDC' | 'EURC' | 'CIRBTC';
  /** Exact input in canonical Arc base units (token-native precision). */
  inputAmount: bigint;
  /** Frozen merchant recipient — server-resolved, never client-supplied. */
  merchantSCA: string;
  /** Optional expected payer binding (echoed into the envelope + verifier). */
  expectedPayer?: string;
  /** Slippage tolerance bps (default: canonical ROUTING_SLIPPAGE_BPS). */
  slippageBps?: number;
  /** Quote expiry unix seconds (default: now + canonical quote TTL). */
  expiresAtSec?: number;
  /** Preferred fee tier hint (default 100; others only via live validation). */
  feeTier?: number;
  /** RPC override (test seam; same network only). */
  rpcUrl?: string;
  /**
   * Self-custody scope (Flow Swap only): payer == recipient == the
   * authenticated user's own wallet. The default (false) preserves the
   * checkout invariant — expectedPayer must be a third party distinct from
   * the merchant recipient. The swap service sets this ONLY for Flow
   * intents where recipient and payer are both the session wallet; the
   * envelope echoes it as `selfPayer` so verification stays bound.
   */
  allowSelfPayer?: boolean;
}

export interface UnitFlowUnsignedTx {
  to: string;
  data: `0x${string}`;
  value: bigint;
  label: string;
}

/**
 * Unsigned UnitFlow V3 execution envelope. Extends the Phase 1
 * UnsignedExecution marker (venueId + phase) with the full unsigned
 * transaction set. NOTHING here is signed or broadcast server-side.
 */
export interface UnitFlowV3ExecutionEnvelope extends UnsignedExecution {
  readonly venueId: 'unitflow-v3';
  readonly phase: 'phase-2-only';
  readonly deployment: UnitFlowV3Deployment;
  /**
   * Which executor this envelope targets: 'universal-router' (testnet —
   * execute(bytes,bytes[],uint256) + Permit2 pull + WUSDC wrap) or
   * 'v3-direct' (mainnet — exactInputSingle against the V3 router, token →
   * router approval, no wrap). Bound at build time from the deployment.
   */
  readonly executor: UnitFlowExecutor;
  /** Validated V3 pool for (tokenIn, tokenOut, fee). */
  readonly pool: string;
  /** Live-validated fee tier bound to this execution. */
  readonly fee: number;
  readonly inputSymbol: 'USDC' | 'EURC' | 'CIRBTC';
  readonly outputSymbol: 'USDC' | 'EURC' | 'CIRBTC';
  readonly tokenInSwap: string;
  readonly tokenOutSwap: string;
  /** Echo of the requested exact input (canonical base units, token-native precision). */
  readonly inputAmountCanonical: bigint;
  /** Exact swap input (swap-leg units; 18-dec on the TESTNET USDC leg, 6-dec identity on mainnet). */
  readonly amountInSwap: bigint;
  readonly quotedOutputSwap: bigint;
  readonly minOutSwap: bigint;
  readonly slippageBps: number;
  readonly merchantSCA: string;
  readonly expectedPayer?: string;
  /** Echo of the build-time self-custody scope (Flow Swap only). */
  readonly selfPayer: boolean;
  /**
   * Universal-router command envelope (executor 'universal-router' ONLY):
   * commands is always the single proven 0x00 byte; inputs carries the
   * 5-param (recipient, amountIn, amountOutMinimum, path, payerIsUser) tuple.
   * On 'v3-direct' commands is the '0x' sentinel with EMPTY inputs — the
   * exactInputSingle calldata binds via v3Direct (below), never via
   * commands/inputs — so the verifier's executor shape gate is unambiguous.
   */
  readonly commands: `0x${string}`;
  readonly inputs: [`0x${string}`] | [];
  /**
   * Direct-V3 exactInputSingle calldata (executor 'v3-direct' ONLY): the
   * exact bytes the wallet broadcasts to the V3 router. Absent on
   * universal-router.
   */
  readonly v3Direct?: `0x${string}`;
  readonly deadline: bigint;
  readonly expiresAtSec: number;
  /**
   * The swap call (value always 0): UniversalRouter execute() on testnet,
   * V3Router exactInputSingle() on mainnet.
   */
  readonly swapTx: UnitFlowUnsignedTx;
  /**
   * Present ONLY on the testnet USDC leg: WUSDC.deposit{value}. NEVER present
   * on v3-direct (mainnet has no wrapper — the USDC leg is native USDC).
   */
  readonly wrapTx?: UnitFlowUnsignedTx;
  /**
   * Unsigned approvals for the customer wallet. Universal-router: two steps
   * (ERC20->Permit2, Permit2->UR). V3-direct: ONE step (token->V3Router
   * directly — the pool pulls via transferFrom through the swap callback).
   */
  readonly approvals: UnitFlowUnsignedTx[];
  /** Pre-broadcast binding identity (keccak over executor/router/calldata/deadline). */
  readonly executionIdentity: string;
}

async function resolveFeeTier(
  client: ReturnType<typeof getRoutingPublicClient>,
  deployment: UnitFlowV3Deployment,
  tokenInSwap: string,
  tokenOutSwap: string,
  amountInSwap: bigint,
  preferredFee: number,
  outputSymbol: 'USDC' | 'EURC' | 'CIRBTC',
  outputSwapDecimals: number,
  slippageBps: number
): Promise<{ fee: number; pool: string; quoted: bigint }> {
  const ordered = [preferredFee, ...UNITFLOW_V3_ALLOWED_FEES.filter((f) => f !== preferredFee)];
  let lastErr: unknown = null;
  for (const fee of ordered) {
    try {
      const pool = (await readWithRetry(`unitflow getPool fee=${fee}`, () =>
        client.readContract({
          address: deployment.factory as `0x${string}`,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [tokenInSwap as `0x${string}`, tokenOutSwap as `0x${string}`, fee],
        })
      )) as string;
      if (!isAddress(pool) || isZeroAddress(pool)) continue;
      const [liquidity, token0, token1] = await readWithRetry(`unitflow pool check fee=${fee}`, () =>
        Promise.all([
          client.readContract({ address: pool as `0x${string}`, abi: POOL_ABI, functionName: 'liquidity' }),
          client.readContract({ address: pool as `0x${string}`, abi: POOL_ABI, functionName: 'token0' }),
          client.readContract({ address: pool as `0x${string}`, abi: POOL_ABI, functionName: 'token1' }),
        ])
      );
      if (liquidity === 0n) continue;
      const pairOk =
        (eqAddr(token0, tokenInSwap) && eqAddr(token1, tokenOutSwap)) ||
        (eqAddr(token0, tokenOutSwap) && eqAddr(token1, tokenInSwap));
      if (!pairOk) continue;
      const quoted = (await readWithRetry(`unitflow quote fee=${fee}`, () =>
        client.readContract({
          address: deployment.quoter as `0x${string}`,
          abi: UNITFLOW_V3_QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [tokenInSwap as `0x${string}`, tokenOutSwap as `0x${string}`, fee, amountInSwap, 0n],
        })
      )) as bigint;
      if (quoted <= 0n) continue;
      // A tier whose quote cannot cover the slippage floor is not a valid
      // tier for this size (dust-liquidity pools quote positive-but-dust and
      // would bind an unexecutable minOut) — try the next tier instead.
      try {
        unitFlowMinOut(quoted, slippageBps, outputSymbol, outputSwapDecimals);
      } catch (e) {
        lastErr = e;
        continue;
      }
      return { fee, pool, quoted };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw routingError(
    503,
    `[unitflow-v3] no live V3 pool with liquidity/quote for this pair (tried ${ordered.join(',')}). Last: ${(lastErr as Error)?.message ?? lastErr}`
  );
}

/**
 * Build the unsigned UnitFlow V3 execution (server-side, no signing, no
 * broadcast). Recipient is ALWAYS the frozen merchantSCA. Performs live
 * Factory.getPool + liquidity + Quoter validation before accepting a fee
 * tier. Throws fail-closed when no tier validates.
 */
export async function buildUnitFlowV3Execution(
  input: UnitFlowV3BuildInput,
  env: Record<string, string | undefined> = process.env
): Promise<UnitFlowV3ExecutionEnvelope> {
  if (!input || typeof input !== 'object') throw routingError(400, '[unitflow-v3] build input malformed.');
  const { inputSymbol, outputSymbol, inputAmount } = input;
  if (inputSymbol !== 'USDC' && inputSymbol !== 'EURC' && inputSymbol !== 'CIRBTC') {
    throw routingError(400, '[unitflow-v3] inputSymbol must be USDC, EURC, or CIRBTC.');
  }
  if (outputSymbol !== 'USDC' && outputSymbol !== 'EURC' && outputSymbol !== 'CIRBTC') {
    throw routingError(400, '[unitflow-v3] outputSymbol must be USDC, EURC, or CIRBTC.');
  }
  if (inputSymbol === outputSymbol) throw routingError(400, '[unitflow-v3] input/output must differ.');
  if (typeof inputAmount !== 'bigint' || inputAmount <= 0n) {
    throw routingError(400, '[unitflow-v3] inputAmount must be a positive bigint.');
  }
  const merchantSCA = (input.merchantSCA ?? '').trim();
  if (!isAddress(merchantSCA)) throw routingError(400, '[unitflow-v3] merchantSCA must be a 0x address.');
  const slippageBps = input.slippageBps ?? ROUTING_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw routingError(400, '[unitflow-v3] slippageBps must be an integer 0..10000.');
  }
  const expiresAtSec =
    input.expiresAtSec ?? Math.floor(Date.now() / 1000) + Math.floor(ROUTING_QUOTE_TTL_MS / 1000);
  if (!Number.isInteger(expiresAtSec) || expiresAtSec <= Math.floor(Date.now() / 1000)) {
    throw routingError(400, '[unitflow-v3] expiresAtSec must be a future unix timestamp.');
  }
  const preferredFee = input.feeTier ?? UNITFLOW_V3_DEFAULT_FEE;
  if (!(UNITFLOW_V3_ALLOWED_FEES as readonly number[]).includes(preferredFee)) {
    throw routingError(400, `[unitflow-v3] feeTier must be one of ${UNITFLOW_V3_ALLOWED_FEES.join(',')}.`);
  }
  const selfPayer = input.allowSelfPayer === true;
  let expectedPayer: string | undefined;
  if (input.expectedPayer !== undefined) {
    if (!isAddress(input.expectedPayer)) throw routingError(400, '[unitflow-v3] expectedPayer must be a 0x address.');
    expectedPayer = input.expectedPayer;
    if (eqAddr(expectedPayer, merchantSCA) && !selfPayer) {
      throw routingError(400, '[unitflow-v3] expectedPayer must not equal the merchant recipient.');
    }
  }

  const deployment = getUnitFlowV3Deployment(env);
  assertUnitFlowDeploymentComplete(deployment);
  const executor = getUnitFlowExecutor(deployment);
  // Executor binding: universal-router deployments execute via
  // deployment.universalRouter; v3-direct deployments execute via the pinned
  // deployment.v3Router. Both are fail-closed on zero/self-recipient.
  const executorAddress =
    executor === 'v3-direct'
      ? (deployment.v3Router ?? deployment.universalRouter)
      : deployment.universalRouter;
  if (!isAddress(executorAddress) || isZeroAddress(executorAddress) || eqAddr(executorAddress, merchantSCA)) {
    throw routingError(503, '[unitflow-v3] deployment router binding invalid.');
  }

  const inLeg = unitFlowSwapLeg(inputSymbol, deployment);
  const outLeg = unitFlowSwapLeg(outputSymbol, deployment);
  const amountInSwap = toSwapUnits(inputSymbol, inputAmount, deployment);
  if (amountInSwap >= 2n ** 160n) throw routingError(400, '[unitflow-v3] input amount exceeds uint160.');
  if (BigInt(expiresAtSec) >= 2n ** 48n) throw routingError(400, '[unitflow-v3] expiry exceeds uint48.');

  const rpcUrl = (input.rpcUrl ?? '').trim() || getNetworkConfig(env).primaryRpc;
  const client = getRoutingPublicClient(rpcUrl);

  const { fee, pool, quoted } = await resolveFeeTier(
    client,
    deployment,
    inLeg.swapAddress,
    outLeg.swapAddress,
    amountInSwap,
    preferredFee,
    outputSymbol,
    outLeg.swapDecimals,
    slippageBps
  );
  const minOutSwap = unitFlowMinOut(quoted, slippageBps, outputSymbol, outLeg.swapDecimals);
  const deadline = BigInt(expiresAtSec);

  // ── Executor-specific call encoding ──────────────────────────────────────
  // Universal-router (testnet): execute(0x00, [v3input], deadline) + Permit2
  // pull + separate WUSDC wrap on the USDC leg.
  // V3-direct (mainnet): exactInputSingle(tokenIn/tokenOut/fee/recipient/
  // deadline/amountIn/amountOutMinimum/0) with a single token->router
  // approval and NO wrap step (native USDC leg, no wrapper on Arc).
  let commands: `0x${string}`;
  let v3input: `0x${string}`;
  let calldata: `0x${string}`;
  let approvals: UnitFlowUnsignedTx[];
  let swapTx: UnitFlowUnsignedTx;
  let wrapTx: UnitFlowUnsignedTx | undefined;
  let executionIdentity: string;

  if (executor === 'v3-direct') {
    calldata = encodeV3DirectExactInputSingle({
      tokenIn: inLeg.swapAddress,
      tokenOut: outLeg.swapAddress,
      fee,
      recipient: merchantSCA,
      deadline,
      amountIn: amountInSwap,
      amountOutMinimum: minOutSwap,
    });
    // Sentinel evidence values: commands/inputs are universal-router
    // concepts. commands '0x' (empty — never the proven 0x00 byte) marks a
    // direct-V3 envelope; inputs carries the exactInputSingle calldata so
    // the identity hash still binds the full execution bytes.
    commands = '0x' as unknown as `0x${string}`;
    v3input = calldata;
    const directApproveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [executorAddress as `0x${string}`, amountInSwap],
    });
    approvals = [
      { to: inLeg.swapAddress, data: directApproveData, value: 0n, label: `${inputSymbol}-token -> V3Router approve` },
    ];
    swapTx = {
      to: executorAddress,
      data: calldata,
      value: 0n,
      label: 'UnitFlowV3Router exactInputSingle',
    };
    // NO wrap step: mainnet has no WUSDC wrapper (native USDC leg).
    executionIdentity = computeUnitFlowExecutionIdentity({
      router: executorAddress,
      commands,
      v3input,
      deadline,
    });
  } else {
    const path = encodePacked(
      ['address', 'uint24', 'address'],
      [inLeg.swapAddress as `0x${string}`, fee, outLeg.swapAddress as `0x${string}`]
    );
    v3input = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
      [merchantSCA as `0x${string}`, amountInSwap, minOutSwap, path, true]
    );
    commands = UNITFLOW_V3_SWAP_EXACT_IN as unknown as `0x${string}`;
    calldata = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, [v3input], deadline],
    });

    const erc20ApproveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [deployment.permit2 as `0x${string}`, amountInSwap],
    });
    const permit2ApproveData = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [
        inLeg.swapAddress as `0x${string}`,
        deployment.universalRouter as `0x${string}`,
        amountInSwap,
        Number(deadline),
      ],
    });

    approvals = [
      { to: inLeg.swapAddress, data: erc20ApproveData, value: 0n, label: `${inputSymbol}-token -> Permit2 approve` },
      { to: deployment.permit2, data: permit2ApproveData, value: 0n, label: `Permit2 allowance -> UniversalRouter` },
    ];

    swapTx = {
      to: deployment.universalRouter,
      data: calldata,
      value: 0n,
      label: 'UniversalRouter execute(V3_SWAP_EXACT_IN)',
    };

    // USDC-leg input conversion: explicit separate wrap (native value -> WUSDC
    // 1:1). NOT a WRAP_ETH command inside execute() — see header.
    if (inputSymbol === 'USDC') {
      const depositData = encodeFunctionData({ abi: WUSDC_ABI, functionName: 'deposit' });
      wrapTx = { to: deployment.wusdc, data: depositData, value: amountInSwap, label: 'WUSDC.deposit (wrap native USDC)' };
    }

    executionIdentity = computeUnitFlowExecutionIdentity({
      router: deployment.universalRouter,
      commands,
      v3input,
      deadline,
    });
  }

  return {
    venueId: 'unitflow-v3',
    phase: 'phase-2-only',
    deployment,
    executor,
    pool,
    fee,
    inputSymbol,
    outputSymbol,
    tokenInSwap: inLeg.swapAddress,
    tokenOutSwap: outLeg.swapAddress,
    inputAmountCanonical: inputAmount,
    amountInSwap,
    quotedOutputSwap: quoted,
    minOutSwap,
    slippageBps,
    merchantSCA,
    selfPayer,
    ...(expectedPayer ? { expectedPayer } : {}),
    commands,
    // Universal-router inputs carry [v3input] (the 5-param tuple). V3-direct
    // inputs carry the sentinel EMPTY tuple — the exactInputSingle calldata
    // binds via v3Direct (below), not inputs — so the verifier's shape gate
    // (sentinel + empty inputs vs 0x00 + [tuple]) is unambiguous.
    inputs: executor === 'v3-direct' ? [] : [v3input],
    ...(executor === 'v3-direct' ? { v3Direct: calldata } : {}),
    deadline,
    expiresAtSec,
    swapTx,
    ...(wrapTx ? { wrapTx } : {}),
    approvals,
    executionIdentity,
  };
}

// ─── Pure: canonical execution-identity encoding (single authority) ──────────
// buildUnitFlowV3Execution() binds the unsigned envelope with exactly this
// hash; verification recomputes it from the DECODED mined calldata and
// compares it to the stored binding (fail-closed on mismatch). One helper,
// used by both sides — no duplicated hashing logic.

export function computeUnitFlowExecutionIdentity(args: {
  router: string;
  commands: `0x${string}`;
  v3input: `0x${string}`;
  deadline: bigint;
}): string {
  return keccak256(
    encodePacked(
      ['address', 'bytes', 'bytes', 'uint256'],
      [args.router as `0x${string}`, args.commands, args.v3input, args.deadline]
    )
  );
}

// ─── Pure: wrap-before-swap ordering ─────────────────────────────────────────
// The USDC-leg wrap and the router execute() are SEPARATE wallet transactions.
// We prove only what the chain shows: both receipts exist, the wrap succeeded,
// and the wrap was included strictly before the swap (deliberately
// conservative — same-block wraps are refused rather than ranked by index).
// This is validated/correlated evidence, NOT cryptographic funding linkage:
// nothing on-chain proves the wrapped WUSDC funded this exact swap.

export function assertWrapBeforeSwap(wrapBlockNumber: bigint, swapBlockNumber: bigint): void {
  if (wrapBlockNumber < 0n || swapBlockNumber < 0n) {
    throw routingError(400, '[unitflow-v3] wrap ordering failed — missing block numbers.');
  }
  if (wrapBlockNumber >= swapBlockNumber) {
    throw routingError(403, '[unitflow-v3] wrap ordering failed — wrap must be included before the swap.');
  }
}

// ─── Pure: WUSDC -> native-USDC unwrap (TESTNET Flow Swap EURC->USDC exit) ───
// The TESTNET UnitFlow V3 pools settle the USDC leg in WUSDC (18-dec). A
// testnet Flow Swap into USDC therefore credits WUSDC first; the user-facing
// settlement is completed by a SEPARATE unsigned WUSDC.withdraw(wad) wallet
// transaction that burns the caller's WUSDC 1:1 into native USDC (the same
// asset the 0x3600… 6-dec ERC-20 view reports).
//
// On v3-direct (mainnet) the USDC leg IS native USDC — this helper is never
// called there (flowNeedsUnwrap() is false, unwrapAmountSwapForIntent()
// refuses). It stays for the testnet executor only.
//
// Evidence basis (Arc Testnet, no invented functions):
//   - WUSDC 0x911b…382Df reads name=Wrapped USDC / symbol=WUSDC / decimals=18
//     live; its bytecode carries both the deposit() (0xd0e30db0) and the
//     canonical WETH9 withdraw(uint256) (0x2e1a7d4d) selectors.
//   - WETH9 semantics: withdraw pays native to msg.sender (no recipient
//     parameter, no approval — the caller burns its own balance), so the
//     unsigned tx below carries value 0 and is signed only by the user's own
//     wallet for the exact verified swap proceeds.
// Nothing here signs, broadcasts, or touches RPC/DB — pure construction and
// decoding only; the swap service binds amounts/recipients server-side.

/**
 * Build the unsigned WUSDC.withdraw(wad) unwrap transaction for the exact
 * verified swap proceeds (swap-leg units, 18-dec). Recipient is implicitly
 * the signing wallet (WETH9 withdraw pays msg.sender) — there is no
 * recipient parameter to get wrong.
 */
export function buildWusdcWithdrawTx(wusdc: string, amountSwap: bigint): UnitFlowUnsignedTx {
  if (!isAddress(wusdc)) throw routingError(400, '[unitflow-v3] WUSDC address must be a 0x address.');
  if (typeof amountSwap !== 'bigint' || amountSwap <= 0n) {
    throw routingError(400, '[unitflow-v3] unwrap amount must be a positive bigint (swap-leg units).');
  }
  const data = encodeFunctionData({ abi: WUSDC_ABI, functionName: 'withdraw', args: [amountSwap] });
  if (!data.toLowerCase().startsWith(UNITFLOW_WUSDC_WITHDRAW_SELECTOR)) {
    throw routingError(500, '[unitflow-v3] withdraw calldata selector drift — refusing.');
  }
  return { to: wusdc, data, value: 0n, label: 'WUSDC.withdraw (receive native USDC)' };
}

/**
 * Decode and strictly validate a WUSDC.withdraw(uint256) calldata payload.
 * Returns the exact wad. Rejects non-hex, wrong-selector, and malformed
 * payloads fail-closed — a foreign or truncated calldata can never satisfy
 * an unwrap verification.
 */
export function decodeWusdcWithdraw(data: unknown): bigint {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data)) {
    throw routingError(400, '[unitflow-v3] malformed withdraw() calldata: not hex.');
  }
  const lower = data.toLowerCase();
  if (!lower.startsWith(UNITFLOW_WUSDC_WITHDRAW_SELECTOR)) {
    throw routingError(400, '[unitflow-v3] malformed withdraw() calldata: wrong selector.');
  }
  // selector (4 bytes) + single uint256 (32 bytes) => 74 chars incl. 0x.
  if (data.length !== 74) {
    throw routingError(400, '[unitflow-v3] malformed withdraw() calldata: bad length.');
  }
  try {
    const decoded = decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}` as `0x${string}`);
    const wad = (decoded as unknown as [bigint])[0];
    if (typeof wad !== 'bigint' || wad <= 0n) throw new Error('non-positive wad');
    return wad;
  } catch {
    throw routingError(400, '[unitflow-v3] malformed withdraw() calldata: undecodable amount.');
  }
}

// ─── verifyExecution() — PURE (no RPC/Prisma/fetch/wallet) ───────────────────
export interface UnitFlowExecutionEvidence {
  deployment: UnitFlowV3Deployment;
  /** Mined execution tx hash (surfaced as the replay/single-consumption id). */
  txHash: string;
  /**
   * tx.to — must be the canonical executor for the deployment (UniversalRouter
   * on universal-router, V3Router on v3-direct).
   */
  to: string;
  /** tx.value — must be 0 on the swap path (wrap is separate / absent). */
  value: bigint | string | number;
  /**
   * Command bytes: '0x00' (single proven V3 exact-input) on
   * 'universal-router', the '0x' sentinel on 'v3-direct' (direct-V3 has no
   * command envelope — the sentinel marks the executor so a UR proof can
   * never satisfy a V3 binding and vice versa).
   */
  commands: string;
  /**
   * Calldata inputs:
   *   - universal-router: single-element [5-param V3 tuple
   *     (recipient/amountIn/minOut/path/payerIsUser)] proven in Gate C;
   *   - v3-direct: EMPTY [] — the exactInputSingle calldata binds via
   *     v3Direct (below), never via inputs.
   * The executor is bound by `commands` + the deployment — never inferred
   * from the bytes alone.
   */
  inputs: string[];
  /**
   * Direct-V3 exactInputSingle calldata (executor 'v3-direct' ONLY): the
   * exact bytes the wallet broadcast to the V3 router. Absent on
   * universal-router.
   */
  v3Direct?: string;
  deadline: bigint | string | number;
  /** tx.from. */
  payer: string;
  expectedPayer: string;
  /** Frozen merchant recipient (decoded recipient must equal this). */
  merchantSCA: string;
  tokenInSwap: string;
  tokenOutSwap: string;
  amountInSwap: bigint | string;
  minOutSwap: bigint | string;
  /** Quoted/validated fee tier (checked against the fee decoded from path). */
  fee: number;
  pool: string;
  expiresAtSec: number;
  /** Inclusion block timestamp (must fall within quote expiry/deadline). */
  txTimestampSec: number;
  /** Settlement-token (swap-leg) merchant balances around the execution. */
  merchantBalanceBefore: bigint | string;
  merchantBalanceAfter: bigint | string;
  /**
   * Self-custody scope echo (Flow Swap only): relaxes ONLY the
   * "merchant cannot be its own payer" rule, because payer == recipient ==
   * the user's own wallet is the entire Flow shape. Default (absent/false)
   * preserves the checkout rule. Every other check — router identity,
   * exact input, output token, fee, pool, expiry, minOut delta, payer ==
   * expectedPayer — applies unchanged.
   */
  allowSelfPayer?: boolean;
}

export interface UnitFlowVerifiedExecution {
  venueId: 'unitflow-v3';
  /** Identity for the future shared single-consumption enforcement. */
  executionTxHash: string;
  router: string;
  payer: string;
  recipient: string;
  inputToken: string;
  inputAmount: bigint;
  outputToken: string;
  /** Measured merchant delta (swap-leg units), >= minOut. */
  actualOutput: bigint;
  minOut: bigint;
  fee: number;
  pool: string;
}

function evBigint(label: string, v: unknown, allowZero: boolean): bigint {
  let b: bigint | null = null;
  try {
    if (typeof v === 'bigint') b = v;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) b = BigInt(v);
    else if (typeof v === 'string' && /^\d+$/.test(v.trim())) b = BigInt(v.trim());
  } catch {
    b = null;
  }
  if (b === null || (!allowZero && b <= 0n) || (allowZero && b < 0n)) {
    throw routingError(400, `[unitflow-v3] missing or malformed execution evidence: ${label}.`);
  }
  return b;
}

function evInt(label: string, v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw routingError(400, `[unitflow-v3] missing or malformed execution evidence: ${label}.`);
  }
  return n;
}

/**
 * Pure verifier: proves the mined execute() matches the frozen quote/intent
 * binding. All chain state arrives as evidence args — this function performs
 * zero I/O. Throws fail-closed on any mismatch; returns the verified
 * execution identity (incl. executionTxHash for future uniqueness
 * enforcement) on success.
 */
export function verifyUnitFlowExecution(ev: UnitFlowExecutionEvidence): UnitFlowVerifiedExecution {
  if (!ev || typeof ev !== 'object') throw routingError(400, '[unitflow-v3] missing execution evidence.');
  const d = ev.deployment;
  if (!d || typeof d !== 'object') throw routingError(400, '[unitflow-v3] missing execution evidence: deployment.');
  try {
    assertUnitFlowDeploymentComplete(d);
  } catch {
    throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: deployment.');
  }
  const executor = getUnitFlowExecutor(d);
  // Canonical executor for THIS deployment — the ONLY address the swap may
  // be addressed to (testnet UniversalRouter, mainnet V3Router).
  const canonicalExecutor =
    executor === 'v3-direct' ? (d.v3Router ?? d.universalRouter) : d.universalRouter;
  // Fail-closed completeness FIRST: the executor shape must be unambiguous
  // before any value below is trusted. Universal-router evidence carries
  // commands '0x00' + exactly one inputs element (the 5-param tuple) and NO
  // v3Direct; v3-direct evidence carries the '0x' commands sentinel with
  // EMPTY inputs and the exactInputSingle calldata in v3Direct. A hybrid
  // (both shapes) or an empty (neither) proof is rejected — an attacker must
  // not be able to smuggle UR bytes into a V3 proof or vice versa.
  const inputs = (ev as any).inputs;
  const hasV3Direct = typeof (ev as any).v3Direct === 'string' && (ev as any).v3Direct.trim() !== '';
  if (executor === 'v3-direct') {
    if (String(ev.commands ?? '').toLowerCase() !== '0x') {
      throw routingError(403, '[unitflow-v3] unexpected command sequence — v3-direct proof must carry the 0x sentinel.');
    }
    if (!Array.isArray(inputs) || inputs.length !== 0) {
      throw routingError(400, '[unitflow-v3] malformed execution evidence: v3-direct proof must carry the commands sentinel with empty inputs.');
    }
    if (!hasV3Direct || !/^0x[0-9a-fA-F]+$/.test((ev as any).v3Direct)) {
      throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: v3Direct.');
    }
  } else {
    if (hasV3Direct) {
      throw routingError(400, '[unitflow-v3] malformed execution evidence: universal-router proof must not carry v3Direct.');
    }
    if (!Array.isArray(inputs) || inputs.length !== 1 || typeof inputs[0] !== 'string') {
      throw routingError(400, '[unitflow-v3] malformed execution evidence: inputs.');
    }
  }

  // A. Executor identity — reject foreign routers.
  if (!isAddress(ev.to) || !eqAddr(ev.to, canonicalExecutor)) {
    throw routingError(
      403,
      executor === 'v3-direct'
        ? '[unitflow-v3] foreign V3Router — tx.to is not the canonical router.'
        : '[unitflow-v3] foreign UniversalRouter — tx.to is not the canonical router.'
    );
  }
  if (typeof ev.txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(ev.txHash)) {
    throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: txHash.');
  }

  // Executor-shaped calldata decode.
  // Universal-router: exactly the single proven V3 exact-input command
  // (0x00); no wrapping/unwrapping/multi-command sequences are supported.
  // V3-direct: exactInputSingle params (tokenIn/tokenOut/fee/recipient/
  // deadline/amountIn/amountOutMinimum/sqrtPriceLimitX96). Both shapes bind
  // the same downstream variables (recipient/amountIn/amountOutMin/fee).
  let recipient: string;
  let amountIn: bigint;
  let amountOutMin: bigint;
  let pathFee: number;
  let payerIsUser: boolean | null = null;
  if (executor === 'v3-direct') {
    // Direct-V3 calldata lives in v3Direct (the exact bytes broadcast to
    // the V3 router — same bytes the envelope binds in its identity hash).
    // The '0x' sentinel + empty inputs were already enforced above; a UR
    // 0x00 proof can never decode as exactInputSingle and vice versa.
    let params: DecodedV3DirectExactInputSingle;
    try {
      params = decodeV3DirectExactInputSingle((ev as any).v3Direct);
    } catch (e: any) {
      if (typeof e?.status === 'number') throw e;
      throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: undecodable.');
    }
    recipient = params.recipient;
    amountIn = params.amountIn;
    amountOutMin = params.amountOutMinimum;
    pathFee = params.fee;
    if (!isAddress(recipient) || amountIn <= 0n || amountOutMin <= 0n) {
      throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: params invalid.');
    }
    if (params.sqrtPriceLimitX96 !== 0n) {
      throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: sqrtPriceLimitX96 must be 0.');
    }
    if (!eqAddr(params.tokenIn, ev.tokenInSwap) || !eqAddr(params.tokenOut, ev.tokenOutSwap)) {
      throw routingError(403, '[unitflow-v3] wrong input/output token — exactInputSingle tokens != frozen swap legs.');
    }
    // The params-tuple deadline must bind exactly to the evidence deadline —
    // otherwise the stored execution-identity binding is not the mined call.
    try {
      const evidenceDeadline = evBigint('deadline', ev.deadline, false);
      if (params.deadline !== evidenceDeadline) {
        throw routingError(403, '[unitflow-v3] deadline binding mismatch — params deadline != evidence deadline.');
      }
    } catch (e: any) {
      if (typeof e?.status === 'number') throw e;
      throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: deadline.');
    }
  } else {
    // Command sequence: exactly the single proven V3 exact-input command.
    // No wrapping/unwrapping/multi-command sequences are supported.
    const commands = (ev.commands ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]*$/.test(commands) || commands.length < 4) {
      throw routingError(400, '[unitflow-v3] malformed execute() calldata: commands.');
    }
    if (commands !== '0x00') {
      const body = commands.slice(2);
      if (body.includes('0b') || body.includes('0c')) {
        throw routingError(403, '[unitflow-v3] unsafe/unsupported wrapper command sequence — only 0x00 is supported.');
      }
      throw routingError(403, '[unitflow-v3] unexpected recipient command sequence — only 0x00 is supported.');
    }
    if (!Array.isArray(ev.inputs) || ev.inputs.length !== 1 || typeof ev.inputs[0] !== 'string') {
      throw routingError(400, '[unitflow-v3] malformed execute() calldata: inputs.');
    }

    // Decode the 5-param V3 exact-input tuple (proven Gate C format).
    let path: string;
    try {
      const decoded = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
        ev.inputs[0] as `0x${string}`
      );
      let decodedFee: number | null = null;
      [recipient, amountIn, amountOutMin, path, payerIsUser] = decoded as unknown as [
        string,
        bigint,
        bigint,
        string,
        boolean
      ];
      void decodedFee;
    } catch {
      throw routingError(400, '[unitflow-v3] malformed execute() calldata: V3 input undecodable.');
    }
    if (!isAddress(recipient!) || amountIn! <= 0n || amountOutMin! <= 0n || payerIsUser !== true) {
      throw routingError(400, '[unitflow-v3] malformed execute() calldata: V3 input fields invalid.');
    }
    // Path binding is decoded below (pathFee + token legs).
    pathFee = -1;
    void path;
  }

  // Swap path carries no native value (universal-router: wrap is a separate
  // tx; v3-direct: no wrap exists at all).
  const value = evBigint('value', ev.value, true);
  if (value !== 0n) {
    throw routingError(403, '[unitflow-v3] unexpected native value in single-command execution.');
  }

  // D. Recipient — decoded from calldata, must equal the frozen merchantSCA.
  if (!isAddress(ev.merchantSCA) || isZeroAddress(ev.merchantSCA) || eqAddr(ev.merchantSCA, canonicalExecutor)) {
    throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: merchantSCA.');
  }
  if (!eqAddr(recipient!, ev.merchantSCA)) {
    throw routingError(403, '[unitflow-v3] wrong merchant recipient — decoded recipient != frozen merchantSCA.');
  }

  // I. Payer — must match the expected third-party payer; never the merchant,
  // router, or zero address as an accidental substitute.
  if (!isAddress(ev.payer) || !isAddress(ev.expectedPayer)) {
    throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: payer.');
  }
  if (!eqAddr(ev.payer, ev.expectedPayer)) {
    throw routingError(403, '[unitflow-v3] payer mismatch — tx payer != expected payer.');
  }
  if (eqAddr(ev.payer, canonicalExecutor) || isZeroAddress(ev.payer)) {
    throw routingError(403, '[unitflow-v3] payer mismatch — router/zero address cannot be the payer.');
  }
  // Self-custody (Flow Swap) is the one scope where payer == recipient is
  // legitimate: the user swaps into their own wallet. Checkout keeps the
  // strict third-party-payer rule.
  if (eqAddr(ev.payer, ev.merchantSCA) && ev.allowSelfPayer !== true) {
    throw routingError(403, '[unitflow-v3] payer mismatch — merchant cannot be its own payer.');
  }

  // Path binding: universal-router decodes the packed tokenIn|fee|tokenOut
  // path (43 bytes => 86 hex chars); v3-direct binds tokenIn/tokenOut/fee
  // from the exactInputSingle params (already checked above) + the allowed
  // fee-tier allowlist.
  let pathTokenIn: string;
  let pathTokenOut: string;
  if (executor === 'v3-direct') {
    pathTokenIn = ev.tokenInSwap;
    pathTokenOut = ev.tokenOutSwap;
    if (!(UNITFLOW_V3_ALLOWED_FEES as readonly number[]).includes(pathFee)) {
      throw routingError(400, '[unitflow-v3] wrong fee tier — exactInputSingle fee is not an allowed V3 tier.');
    }
  } else {
    const path = ((): string => {
      try {
        const decoded = decodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
          ev.inputs[0] as `0x${string}`
        );
        return (decoded as unknown as [string, bigint, bigint, string, boolean])[3];
      } catch {
        throw routingError(400, '[unitflow-v3] malformed execute() calldata: V3 input undecodable.');
      }
    })();
    if (typeof path !== 'string' || !/^0x[0-9a-fA-F]+$/.test(path) || path.length !== 2 + 86) {
      throw routingError(400, '[unitflow-v3] invalid path encoding — expected 43-byte packed V3 path.');
    }
    pathTokenIn = `0x${path.slice(2, 42)}`;
    const pathFeeHex = path.slice(42, 48);
    pathTokenOut = `0x${path.slice(48, 88)}`;
    if (!isAddress(pathTokenIn) || !isAddress(pathTokenOut) || !/^[0-9a-fA-F]{6}$/.test(pathFeeHex)) {
      throw routingError(400, '[unitflow-v3] invalid path encoding — token/fee fields malformed.');
    }
    pathFee = parseInt(pathFeeHex, 16);
    if (!(UNITFLOW_V3_ALLOWED_FEES as readonly number[]).includes(pathFee)) {
      throw routingError(400, '[unitflow-v3] wrong fee tier — path fee is not an allowed V3 tier.');
    }
  }

  // B/C. Input token + exact amount against the persisted binding. Token
  // ordering is checked explicitly (reversed legs fail as ordering, not as a
  // generic token mismatch).
  if (!isAddress(ev.tokenInSwap) || !isAddress(ev.tokenOutSwap)) {
    throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: swap tokens.');
  }
  if (eqAddr(pathTokenIn, ev.tokenOutSwap) && eqAddr(pathTokenOut, ev.tokenInSwap)) {
    throw routingError(403, '[unitflow-v3] invalid path token ordering — legs are reversed.');
  }
  if (!eqAddr(pathTokenIn, ev.tokenInSwap)) {
    throw routingError(403, '[unitflow-v3] wrong input token — path tokenIn != quoted tokenIn.');
  }
  const expectedAmountIn = evBigint('amountInSwap', ev.amountInSwap, false);
  if (amountIn! !== expectedAmountIn) {
    throw routingError(403, '[unitflow-v3] wrong input amount — decoded amountIn != persisted binding.');
  }

  // E. Output token must match the frozen settlement leg.
  if (!eqAddr(pathTokenOut, ev.tokenOutSwap)) {
    throw routingError(403, '[unitflow-v3] wrong output token — path tokenOut != frozen settlement leg.');
  }

  // G. Fee tier decoded from the path must match the quoted/validated tier.
  if (typeof ev.fee !== 'number' || !Number.isInteger(ev.fee)) {
    throw routingError(400, '[unitflow-v3] missing or malformed execution evidence: fee.');
  }
  if (pathFee !== ev.fee) {
    throw routingError(403, '[unitflow-v3] wrong fee tier — path fee != quoted/validated fee.');
  }

  // Pool binding present and well-formed (live-validated at build time; the
  // pure verifier echoes the binding and rejects zero/malformed pools).
  if (!isAddress(ev.pool) || isZeroAddress(ev.pool)) {
    throw routingError(400, '[unitflow-v3] wrong/invalid pool — pool binding missing or zero.');
  }

  // H. Expiry — inclusion must fall within the stored quote expiry/deadline.
  const deadline = evBigint('deadline', ev.deadline, false);
  const expiresAtSec = evInt('expiresAtSec', ev.expiresAtSec);
  const txTimestampSec = evInt('txTimestampSec', ev.txTimestampSec);
  if (txTimestampSec > expiresAtSec || txTimestampSec > deadline || deadline > BigInt(expiresAtSec)) {
    throw routingError(410, '[unitflow-v3] expired quote — execution falls outside the stored expiry/deadline.');
  }

  // F/J. Output amount from merchant balance DELTA (never assume zero
  // baselines — the router and merchant may hold unrelated balances).
  const before = evBigint('merchantBalanceBefore', ev.merchantBalanceBefore, true);
  const after = evBigint('merchantBalanceAfter', ev.merchantBalanceAfter, true);
  if (after < before) {
    throw routingError(403, '[unitflow-v3] merchant settlement balance decreased — cannot verify output.');
  }
  const minOut = evBigint('minOutSwap', ev.minOutSwap, false);
  // The calldata floor must bind exactly to the persisted quote minimum —
  // a weaker on-chain floor is rejected even if the observed delta is large.
  if (amountOutMin! !== minOut) {
    throw routingError(403, '[unitflow-v3] amountOutMinimum binding mismatch — calldata floor != persisted minOut.');
  }
  const delta = after - before;
  if (delta < minOut) {
    throw routingError(403, '[unitflow-v3] output below minOut — merchant delta < persisted minimum.');
  }

  return {
    venueId: 'unitflow-v3',
    executionTxHash: ev.txHash,
    router: ev.to,
    payer: ev.payer,
    recipient: recipient!,
    inputToken: pathTokenIn,
    inputAmount: amountIn!,
    outputToken: pathTokenOut,
    actualOutput: delta,
    minOut,
    fee: pathFee,
    pool: ev.pool,
  };
}

// ─── SwapProvider adapter ────────────────────────────────────────────────────
export class UnitFlowV3Provider implements SwapProvider {
  readonly venueId = 'unitflow-v3' as const;
  quote(_ctx: QuoteContext): Promise<NormalizedProviderQuote> {
    return Promise.reject(
      notImplemented(
        'unitflow-v3',
        'quote() — standalone provider quoting is out of scope (no /api/payments/quote wiring in Phase 2)'
      )
    ) as Promise<NormalizedProviderQuote>;
  }
  buildExecution(input: UnitFlowV3BuildInput): Promise<UnitFlowV3ExecutionEnvelope> {
    return buildUnitFlowV3Execution(input);
  }
  verifyExecution(ev: UnitFlowExecutionEvidence): Promise<UnitFlowVerifiedExecution> {
    return Promise.resolve(verifyUnitFlowExecution(ev));
  }
}
