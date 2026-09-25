// src/lib/swap/service.ts
//
// Shared swap/conversion application service — the backend layer jointly
// supporting Flow Swap (self-custody USDC↔EURC↔cirBTC) and merchant-checkout
// conversion (customer pays X, merchant is settled Y).
//
// Architecture:
//
//   Flow Swap routes (/api/swap/*)          Checkout routes (/api/payments/*)
//            │                                           │
//            └─────────── this service ──────────────────┘
//                        │ (venue-agnostic dispatch)
//              ┌─────────┼─────────────┐
//              │         │             │
//          canonical  tower        unitflow-v3
//          (existing  (quote/       (execution
//           path)     discovery      + verify)
//                      only)
//
// Rules (fail-closed, server-resolved, no silent fallback):
// - Symbols in, addresses/pools/fees/math out — token identity resolves via
//   supportedTokens.ts, deployment via src/lib/config/unitflow.ts, canonical
//   routing via src/lib/routing/*. Nothing client-supplied is trusted for
//   amounts, tokens, pools, routes, recipients, or payers.
// - expectedPayer is NEVER taken from the client. Flow: derived from the
//   authenticated consumer session + verifyCallerControlsAddress. Checkout:
//   permissionless by design — bound from signed/on-chain execution evidence
//   plus the existing sender-hint safeguard (no new ownership helper).
// - Pure verifiers stay pure: this service collects on-chain evidence (RPC)
//   and persists results (Prisma); verifyUnitFlowExecution /
//   checkRoutedExecution only ever receive injected evidence.
// - Wrap (WUSDC.deposit) + approvals + execute() are SEPARATE wallet
//   transactions — never claimed atomic. The wrap hash is persisted as a
//   validated correlation (matching to/from/value receipt + wrap-before-swap
//   ordering + verification-time single-consumption), never as cryptographic
//   funding linkage: nothing on-chain proves the wrapped WUSDC funded this
//   exact swap.
// - Tower is quote/discovery only: consulted best-effort for Flow Swap
//   comparison, never executed, never in checkout.

import { NextRequest } from 'next/server';
import {
  decodeFunctionData,
  encodePacked,
  erc20Abi,
  keccak256,
  parseUnits,
} from 'viem';
import { prisma } from '@/src/lib/prisma';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { verifyCallerControlsAddress } from '@/src/lib/wallet/verifyCallerControlsAddress';
import { getNetworkConfig } from '@/src/lib/config/network';
import {
  getUnitFlowV3Deployment,
  type UnitFlowV3Deployment,
} from '@/src/lib/config/unitflow';
import { getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import { resolveRowCurrency } from '@/src/lib/tokens/resolveCurrency';
import {
  ROUTING_OUT_FEE_BUFFER,
  ROUTING_QUOTE_TTL_MS,
  ROUTING_SLIPPAGE_BPS,
  getRoutingPublicClient,
  readWithRetry,
  routingError,
} from '@/src/lib/routing/canonical';
import {
  createVenueRegistry,
  type VenueRegistry,
} from '@/src/lib/routing/providers/registry';
import { TowerProvider, requestTowerQuote } from '@/src/lib/routing/providers/tower';
import {
  UNITFLOW_6_TO_18_SCALE,
  UNITFLOW_V3_DIRECT_ROUTER_ABI,
  UNITFLOW_V3_ROUTER_ABI,
  assertWrapBeforeSwap,
  buildUnitFlowV3Execution,
  buildWusdcWithdrawTx,
  computeUnitFlowExecutionIdentity,
  decodeV3DirectExactInputSingle,
  decodeWusdcWithdraw,
  getUnitFlowExecutor,
  verifyUnitFlowExecution,
  UnitFlowV3Provider,
  type UnitFlowExecutionEvidence,
  type UnitFlowV3ExecutionEnvelope,
} from '@/src/lib/routing/providers/unitflowV3';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SWAP_SYMBOLS = ['USDC', 'EURC', 'CIRBTC'] as const;
export type SwapSymbol = (typeof SWAP_SYMBOLS)[number];

/** Checkout UnitFlow v1 scope: USDC in → EURC out only (see header). */
export const CHECKOUT_UNITFLOW_INPUT: SwapSymbol = 'USDC';
export const CHECKOUT_UNITFLOW_OUTPUT: SwapSymbol = 'EURC';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TXHASH_RE = /^0x[a-fA-F0-9]{64}$/;

/** Max input-search iterations when sizing a UnitFlow checkout quote. */
const CHECKOUT_INPUT_SEARCH_MAX = 15;

// ─── Pure: input validation ──────────────────────────────────────────────────

export function assertSwapSymbol(v: unknown): SwapSymbol {
  const s = String(v ?? '').trim().toUpperCase();
  if (s !== 'USDC' && s !== 'EURC' && s !== 'CIRBTC') {
    throw routingError(400, `Unsupported swap token: "${String(v ?? '')}". Flow Swap supports USDC, EURC, and CIRBTC.`);
  }
  return s;
}

export function assertDistinctPair(input: SwapSymbol, output: SwapSymbol): void {
  if (input === output) {
    throw routingError(400, 'Swap input and output must differ — same-token payments need no conversion.');
  }
}

/** Strict decimal string → canonical base units (token-native precision, never float math). */
export function parseCanonicalAmount(raw: unknown, decimals = 6): bigint {
  if (!Number.isInteger(decimals) || decimals <= 0 || decimals > 18) {
    throw routingError(400, 'Token precision is misconfigured — refusing to parse the amount.');
  }
  const s = String(raw ?? '').trim();
  const re = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!re.test(s)) {
    throw routingError(400, `Amount must be a positive number with up to ${decimals} decimals (got "${String(raw ?? '')}").`);
  }
  const v = parseUnits(s, decimals);
  if (v <= 0n) throw routingError(400, 'Amount must be greater than 0.');
  return v;
}

function assertAddress(label: string, v: unknown): string {
  if (typeof v !== 'string' || !ADDRESS_RE.test(v.trim())) {
    throw routingError(400, `${label} must be a 0x EVM address.`);
  }
  return v.trim();
}

function assertTxHash(label: string, v: unknown): string {
  if (typeof v !== 'string' || !TXHASH_RE.test(v.trim())) {
    throw routingError(400, `${label} must be a 0x transaction hash.`);
  }
  return v.trim();
}

// ─── Pure: provider dispatch ─────────────────────────────────────────────────
// Canonical is the default everywhere. Tower can never satisfy checkout
// (quote-only — no buildExecution/verifyExecution). UnitFlow requires its
// opt-in flag via the registry's fail-closed selection.

export function getSwapRegistry(
  env: Record<string, string | undefined> = process.env
): VenueRegistry {
  void env;
  return createVenueRegistry([new TowerProvider(), new UnitFlowV3Provider()]);
}

export type CheckoutVenueId = 'canonical' | 'unitflow-v3';

/**
 * Resolve the checkout execution venue from an optional symbolic client
 * hint. Absent → canonical (existing behavior unchanged). Tower is rejected
 * outright (quote-only venue, no checkout execution). UnitFlow is returned
 * only after the registry's fail-closed enabled check passes.
 */
export function resolveCheckoutVenueId(
  requested: unknown,
  env: Record<string, string | undefined> = process.env
): CheckoutVenueId {
  const v = String(requested ?? '').trim().toLowerCase();
  if (v === '' || v === 'canonical') return 'canonical';
  if (v === 'tower') {
    throw routingError(400, '[tower] Tower is quote/discovery only — merchant checkout cannot execute on Tower.');
  }
  if (v === 'unitflow-v3' || v === 'unitflow') {
    getSwapRegistry(env).selectProvider('unitflow-v3', env);
    return 'unitflow-v3';
  }
  throw routingError(400, `Unknown checkout venue "${String(requested ?? '')}". Supported: canonical, unitflow-v3.`);
}

/**
 * Resolve the Flow Swap executor venue. v1 executes ONLY on UnitFlow
 * (proven executor); the registry must have it enabled or quoting fails
 * closed. Tower may be consulted for comparison separately — never as the
 * executor.
 */
export function resolveFlowVenueId(
  env: Record<string, string | undefined> = process.env
): 'unitflow-v3' {
  getSwapRegistry(env).selectProvider('unitflow-v3', env);
  return 'unitflow-v3';
}

// ─── Pure: provider-aware quote binding ──────────────────────────────────────
// Canonical quote hashing (quoteMath.computeQuoteHash) is PRESERVED untouched
// for canonical routing. UnitFlow quotes bind the complete execution-critical
// quote under a distinct domain so a canonical hash can never satisfy a
// UnitFlow verification and vice versa.

export interface SwapQuoteHashArgs {
  scope: 'checkout' | 'flow';
  /** Payment reference (checkout) or owner wallet (flow). */
  bindingRef: string;
  venueId: string;
  deploymentName: string;
  inputToken: string;
  inputAmount: bigint;
  outputToken: string;
  quotedOutputSwap: bigint;
  minOutSwap: bigint;
  pool: string;
  fee: number;
  expiresAtSec: number;
  recipient: string;
  /** Bound payer, or '' when unbound (permissionless checkout at quote). */
  expectedPayer: string;
}

export function computeSwapQuoteHash(a: SwapQuoteHashArgs): `0x${string}` {
  if (a.scope !== 'checkout' && a.scope !== 'flow') {
    throw routingError(400, 'Swap quote scope must be checkout or flow.');
  }
  return keccak256(
    encodePacked(
      [
        'string', 'string', 'string',
        'address', 'uint256', 'address', 'uint256', 'uint256',
        'string', 'string', 'address', 'uint24', 'uint256',
        'address', 'address',
      ],
      [
        'arcflare-swap-v1',
        a.scope,
        a.bindingRef,
        assertAddress('inputToken', a.inputToken) as `0x${string}`,
        a.inputAmount,
        assertAddress('outputToken', a.outputToken) as `0x${string}`,
        a.quotedOutputSwap,
        a.minOutSwap,
        a.venueId,
        a.deploymentName,
        assertAddress('pool', a.pool) as `0x${string}`,
        a.fee,
        BigInt(a.expiresAtSec),
        assertAddress('recipient', a.recipient) as `0x${string}`,
        (a.expectedPayer.trim() === '' ? ZERO_ADDRESS : assertAddress('expectedPayer', a.expectedPayer)) as `0x${string}`,
      ]
    )
  );
}

export function swapIdempotencyKey(prefix: 'flowswap' | 'quote', id: string, quoteHash: string): string {
  return `${prefix}-${id}-${quoteHash.slice(2, 18)}`;
}

/** Swap-leg units → canonical base units (exact; TESTNET USDC leg rescales /1e12, mainnet USDC leg + EURC/cirBTC legs are identity). */
export function canonicalFromSwapUnits(
  symbol: SwapSymbol,
  amountSwap: bigint,
  deployment?: UnitFlowV3Deployment
): bigint {
  if (amountSwap <= 0n) throw routingError(400, 'Swap amount must be positive.');
  if (symbol !== 'USDC') return amountSwap;
  if (deployment && getUnitFlowExecutor(deployment) === 'v3-direct') return amountSwap;
  if (amountSwap % UNITFLOW_6_TO_18_SCALE !== 0n) {
    throw routingError(503, '[unitflow-v3] USDC-leg amount is not 1e12-aligned — refusing to rescale.');
  }
  return amountSwap / UNITFLOW_6_TO_18_SCALE;
}

// ─── Pure: execute() calldata decoding ───────────────────────────────────────
// Decodes MINED tx calldata with the single-authority router ABI (no RPC).
// Executor-aware: universal-router deployments decode execute(bytes,bytes[],
// uint256); v3-direct deployments (mainnet) decode exactInputSingle(((…))).
// The return shape is shared: v3-direct params are re-expressed as the
// equivalent universal-router evidence (commands '0x' sentinel + inputs
// [exactInputSingle calldata] + deadline from the params tuple) so the
// downstream verifier branches on ONE executor value with no second decoder.

export interface DecodedUnitFlowExecute {
  commands: `0x${string}`;
  inputs: [`0x${string}`];
  deadline: bigint;
}

export function decodeUnitFlowExecute(
  data: unknown,
  deployment?: UnitFlowV3Deployment
): DecodedUnitFlowExecute {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data)) {
    throw routingError(400, '[unitflow-v3] malformed execute() calldata: not hex.');
  }
  // V3-direct shape first when the deployment selects it (mainnet): the
  // execute() selector never decodes as exactInputSingle and vice versa, so
  // order is unambiguous — a foreign calldata fails closed in both decoders.
  if (deployment && getUnitFlowExecutor(deployment) === 'v3-direct') {
    try {
      const params = decodeV3DirectExactInputSingle(data);
      return {
        commands: '0x' as unknown as `0x${string}`,
        inputs: [data as `0x${string}`],
        deadline: params.deadline,
      };
    } catch (e: any) {
      if (typeof e?.status === 'number') throw e;
      throw routingError(400, '[unitflow-v3] malformed exactInputSingle() calldata: undecodable.');
    }
  }
  try {
    const decoded = decodeFunctionData({ abi: UNITFLOW_V3_ROUTER_ABI, data: data as `0x${string}` });
    if (decoded.functionName !== 'execute') throw new Error('not execute()');
    const [commands, inputs, deadline] = decoded.args as unknown as [`0x${string}`, `0x${string}`[], bigint];
    if (!Array.isArray(inputs) || inputs.length !== 1) {
      throw routingError(400, '[unitflow-v3] malformed execute() calldata: inputs.');
    }
    return { commands, inputs: [inputs[0]!], deadline };
  } catch (e: any) {
    if (typeof e?.status === 'number') throw e;
    throw routingError(400, '[unitflow-v3] malformed execute() calldata: undecodable.');
  }
}

// ─── Pure: wrap-transaction linkage ──────────────────────────────────────────
// The USDC-leg wrap (WUSDC.deposit{value}) is a SEPARATE wallet transaction
// from the router execute(). Linkage is proven per-receipt: destination is
// the canonical WUSDC contract, value equals the expected swap-leg amount,
// sender equals the swap payer, and the wrap succeeded. Anything else fails
// closed — a wrap tx and a swap tx are never assumed to be one transaction.

export interface WrapLinkageEvidence {
  wrapTo: string;
  wrapFrom: string;
  wrapValue: bigint | string | number;
  wrapStatus: string;
}

export interface WrapLinkageExpectation {
  wusdc: string;
  payer: string;
  amountInSwap: bigint | string;
}

function toLinkBigint(v: bigint | string | number): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
  } catch {
    return null;
  }
}

export function checkWrapLinkage(ev: WrapLinkageEvidence, exp: WrapLinkageExpectation): void {
  const eq = (a: string, b: string) => a?.toLowerCase() === b?.toLowerCase();
  if (!ADDRESS_RE.test(ev.wrapTo ?? '') || !eq(ev.wrapTo, exp.wusdc)) {
    throw routingError(403, '[unitflow-v3] wrap linkage failed — wrap destination is not the canonical WUSDC contract.');
  }
  if (!ADDRESS_RE.test(ev.wrapFrom ?? '') || !eq(ev.wrapFrom, exp.payer)) {
    throw routingError(403, '[unitflow-v3] wrap linkage failed — wrap sender is not the swap payer.');
  }
  const value = toLinkBigint(ev.wrapValue);
  const expected = toLinkBigint(exp.amountInSwap);
  if (value === null || expected === null || value !== expected) {
    throw routingError(403, '[unitflow-v3] wrap linkage failed — wrapped amount != expected swap-leg amount.');
  }
  if ((ev.wrapStatus ?? '').toLowerCase() !== 'success') {
    throw routingError(403, '[unitflow-v3] wrap linkage failed — wrap transaction did not succeed.');
  }
}

// ─── Application: authenticated payer (Flow) ─────────────────────────────────
// The ONLY Flow payer source: the consumer session wallet, gated by the
// single ownership helper. No default payer, no fallback, no body wallet.

export interface FlowPayer {
  wallet: string;
  actor: { type: string; id: string; walletAddress: string };
}

export async function resolveFlowPayer(req: NextRequest): Promise<FlowPayer> {
  const sessionWallet = await resolveConsumerSession(req).catch(() => null);
  if (!sessionWallet || !ADDRESS_RE.test(sessionWallet.trim())) {
    throw routingError(401, 'Sign in required — Flow Swap needs an authenticated consumer wallet.');
  }
  const wallet = sessionWallet.trim();
  const actor = await verifyCallerControlsAddress(req, wallet);
  if (!actor) {
    throw routingError(403, 'Wallet ownership could not be verified for this session — refusing to quote.');
  }
  return { wallet, actor: { type: actor.type, id: actor.id, walletAddress: actor.walletAddress } };
}

// ─── Application: unsigned-tx JSON views ─────────────────────────────────────
// Bigints never cross the API boundary — values/deadlines serialize as
// decimal strings. The server never signs: these are returned for the
// user's wallet to sign and broadcast.

export interface UnsignedTxJson {
  to: string;
  data: `0x${string}`;
  value: string;
  label: string;
}

function txJson(t: { to: string; data: `0x${string}`; value: bigint; label: string }): UnsignedTxJson {
  return { to: t.to, data: t.data, value: t.value.toString(), label: t.label };
}

export interface FlowQuoteView {
  intentId: string;
  quoteHash: string;
  idempotencyKey: string;
  executionIdentity: string;
  venueId: 'unitflow-v3';
  deploymentName: string;
  input: { symbol: SwapSymbol; address: string; amount: string; amountDisplay: string };
  output: { symbol: SwapSymbol; address: string; quoted: string; minOut: string };
  pool: string;
  feeTier: number;
  slippageBps: number;
  quoteExpiresAt: string;
  deadline: string;
  recipient: string;
  expectedPayer: string;
  unsigned: { approvals: UnsignedTxJson[]; wrapTx: UnsignedTxJson | null; swapTx: UnsignedTxJson };
}

// ─── Application: Flow Swap quote ────────────────────────────────────────────

export interface FlowQuoteRequest {
  ownerWallet: string;
  inputSymbol: SwapSymbol;
  outputSymbol: SwapSymbol;
  inputAmount: bigint;
  env?: Record<string, string | undefined>;
}

function shortIdem(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'owner';
}

export async function requestFlowSwapQuote(
  req: FlowQuoteRequest
): Promise<{ view: FlowQuoteView; tower: TowerCandidate }> {
  const env = req.env ?? process.env;
  assertDistinctPair(req.inputSymbol, req.outputSymbol);
  const ownerWallet = assertAddress('ownerWallet', req.ownerWallet);
  if (req.inputAmount <= 0n) throw routingError(400, 'Swap input amount must be positive.');

  const venueId = resolveFlowVenueId(env);
  const deployment = getUnitFlowV3Deployment(env);
  const inputToken = getTokenBySymbol(req.inputSymbol);
  const outputToken = getTokenBySymbol(req.outputSymbol);
  const slippageBps = ROUTING_SLIPPAGE_BPS;
  const expiresAtSec = Math.floor(Date.now() / 1000) + Math.floor(ROUTING_QUOTE_TTL_MS / 1000);
  const quoteExpiresAt = new Date(expiresAtSec * 1000);

  // Live-validated unsigned execution: Factory/Quoter checks run inside the
  // builder (RPC reads only — nothing is signed or broadcast server-side).
  // Self-custody scope: payer == recipient == session wallet.
  const envelope = await buildUnitFlowV3Execution(
    {
      inputSymbol: req.inputSymbol,
      outputSymbol: req.outputSymbol,
      inputAmount: req.inputAmount,
      merchantSCA: ownerWallet,
      expectedPayer: ownerWallet,
      allowSelfPayer: true,
      slippageBps,
      expiresAtSec,
    },
    env
  );
  if (envelope.selfPayer !== true) {
    throw routingError(503, '[unitflow-v3] execution scope binding lost — refusing to persist.');
  }

  const quoteHash = computeSwapQuoteHash({
    scope: 'flow',
    bindingRef: ownerWallet.toLowerCase(),
    venueId,
    deploymentName: deployment.name,
    inputToken: inputToken.address,
    inputAmount: req.inputAmount,
    outputToken: outputToken.address,
    quotedOutputSwap: envelope.quotedOutputSwap,
    minOutSwap: envelope.minOutSwap,
    pool: envelope.pool,
    fee: envelope.fee,
    expiresAtSec,
    recipient: ownerWallet,
    expectedPayer: ownerWallet,
  });
  const idempotencyKey = swapIdempotencyKey('flowswap', shortIdem(ownerWallet), quoteHash);

  const rowBase = {
    ownerWallet,
    inputSymbol: req.inputSymbol,
    outputSymbol: req.outputSymbol,
    inputAmount: req.inputAmount.toString(),
    inputAmountSwap: envelope.amountInSwap.toString(),
    tokenInSwap: envelope.tokenInSwap,
    tokenOutSwap: envelope.tokenOutSwap,
    quotedOutputSwap: envelope.quotedOutputSwap.toString(),
    minOutputSwap: envelope.minOutSwap.toString(),
    venueId,
    deploymentName: deployment.name,
    deploymentRouter: deployment.universalRouter,
    poolAddress: envelope.pool,
    feeTier: envelope.fee,
    slippageBps,
    quoteExpiresAt,
    deadline: envelope.deadline.toString(),
    quoteHash,
    executionIdentity: envelope.executionIdentity,
    idempotencyKey,
    expectedPayer: ownerWallet,
    recipient: ownerWallet,
    status: 'QUOTED',
  };

  // Expire stale live intents for the same owner+pair+input (one live
  // intent per swap shape — mirrors the canonical quoter's single live
  // conversion per payment).
  const stale = await (prisma as any).flowSwapIntent.findMany({
    where: {
      ownerWallet: { equals: ownerWallet, mode: 'insensitive' },
      inputSymbol: req.inputSymbol,
      outputSymbol: req.outputSymbol,
      inputAmount: req.inputAmount.toString(),
      status: 'QUOTED',
    },
  });
  const now = Date.now();
  const live = (stale as any[]).filter((r) => new Date(r.quoteExpiresAt).getTime() > now);
  for (const r of live) {
    // A live row for the identical shape is only reusable when its binding
    // matches this fresh live validation exactly; otherwise it is history.
    if (
      r.poolAddress?.toLowerCase() === envelope.pool.toLowerCase() &&
      r.feeTier === envelope.fee &&
      r.quotedOutputSwap === envelope.quotedOutputSwap.toString() &&
      r.minOutputSwap === envelope.minOutSwap.toString() &&
      r.executionIdentity === envelope.executionIdentity
    ) {
      return { view: intentToView(r, envelope), tower: await getTowerCandidate(req) };
    }
  }
  if (stale.length > 0) {
    await (prisma as any).flowSwapIntent.updateMany({
      where: { id: { in: (stale as any[]).map((r) => r.id) } },
      data: { status: 'EXPIRED' },
    });
  }

  let created: any;
  try {
    created = await (prisma as any).flowSwapIntent.create({ data: rowBase });
  } catch (e: any) {
    // Same-second race: identical quoteHash/idempotencyKey won elsewhere.
    if (e?.code === 'P2002') {
      const winner = await (prisma as any).flowSwapIntent.findUnique({ where: { quoteHash } }).catch(() => null);
      if (winner && winner.status === 'QUOTED' && new Date(winner.quoteExpiresAt).getTime() > Date.now()) {
        return { view: intentToView(winner, envelope), tower: await getTowerCandidate(req) };
      }
    }
    throw e;
  }
  return { view: intentToView(created, envelope), tower: await getTowerCandidate(req) };
}

function intentToView(row: any, envelope: UnitFlowV3ExecutionEnvelope): FlowQuoteView {
  const inputToken = getTokenBySymbol(row.inputSymbol as SwapSymbol);
  const outputToken = getTokenBySymbol(row.outputSymbol as SwapSymbol);
  const display = (v: string, decimals: number) => {
    try {
      const b = BigInt(v);
      const s = b.toString().padStart(decimals + 1, '0');
      return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/^0+(?=\d)/, '') || `0.${'0'.repeat(decimals)}`;
    } catch {
      return v;
    }
  };
  return {
    intentId: row.id,
    quoteHash: row.quoteHash,
    idempotencyKey: row.idempotencyKey,
    executionIdentity: row.executionIdentity,
    venueId: 'unitflow-v3',
    deploymentName: row.deploymentName,
    input: { symbol: row.inputSymbol, address: inputToken.address, amount: row.inputAmount, amountDisplay: display(row.inputAmount, inputToken.decimals) },
    output: {
      symbol: row.outputSymbol,
      address: outputToken.address,
      quoted: row.quotedOutputSwap,
      minOut: row.minOutputSwap,
    },
    pool: row.poolAddress,
    feeTier: row.feeTier,
    slippageBps: row.slippageBps,
    quoteExpiresAt: new Date(row.quoteExpiresAt).toISOString(),
    deadline: row.deadline,
    recipient: row.recipient,
    expectedPayer: row.expectedPayer,
    unsigned: {
      approvals: envelope.approvals.map(txJson),
      wrapTx: envelope.wrapTx ? txJson(envelope.wrapTx) : null,
      swapTx: txJson(envelope.swapTx),
    },
  };
}

// ─── Application: Tower candidate (quote/discovery only) ─────────────────────
// Best-effort and NEVER authoritative: Tower has no execution path, and its
// unit convention is still unverified live. Failures, missing config, or a
// disabled flag yield { consulted, available: false } — the UnitFlow quote
// above remains the single executor either way.

export interface TowerCandidate {
  consulted: boolean;
  available: boolean;
  quotedOutput?: string;
  minOut?: string;
  note: string;
}

export async function getTowerCandidate(
  req: Pick<FlowQuoteRequest, 'inputSymbol' | 'outputSymbol' | 'inputAmount' | 'env'>
): Promise<TowerCandidate> {
  const env = req.env ?? process.env;
  // Temporary diagnostic (no secret values): flag value is safe to log;
  // the API key is logged as present/absent only, never its value.
  const flagRaw = env.ROUTING_PROVIDER_TOWER_ENABLED ?? '';
  const flag = flagRaw.trim().toLowerCase();
  const keyPresent = ((env.TOWER_SWAP_API_KEY ?? '').trim().length > 0);
  const baseRaw = (env.TOWER_SWAP_BASE_URL ?? '').trim();
  let baseHost = '(default https://www.tower.exchange)';
  if (baseRaw) {
    try {
      baseHost = new URL(baseRaw).host;
    } catch {
      baseHost = '(invalid TOWER_SWAP_BASE_URL)';
    }
  }
  console.log(
    `[tower-diag] getTowerCandidate start flag=${JSON.stringify(flagRaw)} keyPresent=${keyPresent} ` +
      `baseHost=${baseHost} pair=${req.inputSymbol}->${req.outputSymbol} amount=${req.inputAmount.toString()}`
  );
  if (flag !== '1' && flag !== 'true') {
    console.log('[tower-diag] getTowerCandidate skip consulted=false available=false reason=flag-off');
    return { consulted: false, available: false, note: 'Tower discovery disabled (flag off).' };
  }
  if (!keyPresent) {
    console.log('[tower-diag] getTowerCandidate skip consulted=true available=false reason=no-api-key');
    return { consulted: true, available: false, note: 'Tower discovery unavailable (no API key).' };
  }
  try {
    const q = await requestTowerQuote(
      { inputSymbol: req.inputSymbol, outputSymbol: req.outputSymbol, inputAmount: req.inputAmount },
      env
    );
    console.log(
      `[tower-diag] getTowerCandidate ok consulted=true available=true quotedOutput=${q.quotedOutputAmount.toString()}`
    );
    return {
      consulted: true,
      available: true,
      quotedOutput: q.quotedOutputAmount.toString(),
      ...(q.minOutputAmount !== undefined ? { minOut: q.minOutputAmount.toString() } : {}),
      note: 'Informational candidate only — Tower does not execute; UnitFlow remains the executor.',
    };
  } catch (e: any) {
    console.log(
      `[tower-diag] getTowerCandidate fail consulted=true available=false err=${String(e?.message ?? e).slice(0, 160)}`
    );
    return { consulted: true, available: false, note: `Tower discovery failed closed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

// ─── Application: intent lookup + registration ───────────────────────────────

export interface IntentLocator {
  intentId?: string;
  quoteHash?: string;
}

export async function loadFlowIntent(ownerWallet: string, loc: IntentLocator): Promise<any> {
  if (!loc.intentId && !loc.quoteHash) {
    throw routingError(400, 'intentId or quoteHash is required.');
  }
  const row = loc.intentId
    ? await (prisma as any).flowSwapIntent.findUnique({ where: { id: loc.intentId } })
    : await (prisma as any).flowSwapIntent.findUnique({ where: { quoteHash: loc.quoteHash! } });
  if (!row) throw routingError(404, 'Swap intent not found.');
  if (String(row.ownerWallet).toLowerCase() !== ownerWallet.toLowerCase()) {
    throw routingError(403, 'This swap intent belongs to a different wallet — refusing.');
  }
  return row;
}

/** Live-check: EXECUTED rows are terminal; expired QUOTED rows flip to EXPIRED. */
export async function assertIntentLive(row: any): Promise<any> {
  if (row.status === 'EXECUTED') {
    throw routingError(409, 'This swap intent is already consumed.');
  }
  if (row.status !== 'QUOTED') {
    throw routingError(400, 'This swap intent is no longer live — request a fresh quote.');
  }
  if (new Date(row.quoteExpiresAt).getTime() <= Date.now()) {
    await (prisma as any).flowSwapIntent.update({ where: { id: row.id }, data: { status: 'EXPIRED' } }).catch(() => null);
    throw routingError(410, 'Swap quote expired before execution — request a fresh quote.');
  }
  return row;
}

// ─── DB-backed atomic single-consumption (execution + wrap tx hashes) ────────
// The per-write `pg_advisory_xact_lock(hashtext(...))` below serializes all
// concurrent claimants for one transaction hash INSIDE the final write
// transaction. The in-transaction rechecks then decide deterministically:
// first committer wins, every other claimant (same or cross table) gets 409.
// This closes the check-then-act race that a SELECT pre-check alone cannot.
// Advisory locks are transaction-scoped (auto-released on commit/rollback),
// keyed by the tx hash only (no owner/row data — lock order is a single key,
// so no deadlock cycle is possible), and add no schema/migration surface.

function advisoryLockKey(txHash: string): string {
  return `swap-tx-claim:${txHash.trim().toLowerCase()}`;
}

/** Serialize claimants for one tx hash inside the enclosing transaction. */
export async function claimTxSlot(db: any, txHash: string): Promise<void> {
  await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', advisoryLockKey(txHash));
}

/** In-transaction cross-table single-consumption recheck (no TOCTOU gap). */
export async function recheckExecutionConsumerTx(
  db: any,
  txHash: string,
  self: { kind: 'flow'; id: string } | { kind: 'checkout'; paymentLogId: string }
): Promise<void> {
  const h = txHash.trim();
  const flow = await db.flowSwapIntent.findUnique({ where: { executionTxHash: h } }).catch(() => null);
  if (flow && !(self.kind === 'flow' && flow.id === self.id)) {
    throw routingError(409, 'This transaction was already consumed by another swap or payment.');
  }
  const conv = await db.paymentConversion.findUnique({ where: { executionTxHash: h } }).catch(() => null);
  if (conv && !(self.kind === 'checkout' && conv.paymentLogId === self.paymentLogId)) {
    throw routingError(409, 'This transaction was already consumed by another swap or payment.');
  }
}

/** In-transaction cross-table wrap single-consumption recheck. */
export async function recheckWrapConsumerTx(
  db: any,
  wrapTxHash: string,
  self: { kind: 'flow'; id: string } | { kind: 'checkout'; paymentLogId: string }
): Promise<void> {
  const flow = await db.flowSwapIntent.findUnique({ where: { wrapTxHash } }).catch(() => null);
  if (flow && !(self.kind === 'flow' && flow.id === self.id)) {
    throw routingError(409, 'This wrap transaction is already tracked by another swap or payment.');
  }
  const conv = await db.paymentConversion.findUnique({ where: { wrapTxHash } }).catch(() => null);
  if (conv && !(self.kind === 'checkout' && conv.paymentLogId === self.paymentLogId)) {
    throw routingError(409, 'This wrap transaction is already tracked by another swap or payment.');
  }
}

/** Map a lost uniqueness race at commit time to a deterministic 409. */
export function executionConflict(e: any): Error & { status: number } {
  if (e?.code === 'P2002') {
    return routingError(409, 'This transaction was already consumed by another swap or payment.');
  }
  throw e;
}

/** Cross-table single-consumption: one execution tx settles at most one intent/payment. */
export async function findExecutionConsumer(txHash: string): Promise<
  | { kind: 'flow'; id: string; ownerWallet: string }
  | { kind: 'checkout'; paymentLogId: string }
  | null
> {
  const h = txHash.trim();
  const flow = await (prisma as any).flowSwapIntent
    .findUnique({ where: { executionTxHash: h } })
    .catch(() => null);
  if (flow) return { kind: 'flow', id: flow.id, ownerWallet: flow.ownerWallet };
  const conv = await (prisma as any).paymentConversion
    .findUnique({ where: { executionTxHash: h } })
    .catch(() => null);
  if (conv) return { kind: 'checkout', paymentLogId: conv.paymentLogId };
  return null;
}

export interface RegisterExecutionRequest extends IntentLocator {
  ownerWallet: string;
  wrapTxHash?: string | null;
  executionTxHash: string;
}

/**
 * Persist broadcast hashes for a live intent (status stays QUOTED until
 * on-chain verification). Universal-router (testnet): wrap is required
 * up-front for USDC-leg inputs — the swap cannot succeed without WUSDC, so
 * fail fast instead of tracking an unexecutable intent. V3-direct
 * (mainnet): no wrap exists — a supplied wrap hash is rejected outright.
 */
export async function registerFlowSwapExecution(req: RegisterExecutionRequest): Promise<any> {
  const ownerWallet = assertAddress('ownerWallet', req.ownerWallet);
  const executionTxHash = assertTxHash('executionTxHash', req.executionTxHash);
  const row = await loadFlowIntent(ownerWallet, req);
  await assertIntentLive(row);

  const consumed = await findExecutionConsumer(executionTxHash);
  if (consumed && !(consumed.kind === 'flow' && consumed.id === row.id)) {
    throw routingError(409, 'This transaction was already consumed by another swap or payment.');
  }

  const deployment = getUnitFlowV3Deployment();
  const executor = getUnitFlowExecutor(deployment);
  let wrapTxHash: string | null = row.wrapTxHash ?? null;
  if (req.wrapTxHash !== undefined && req.wrapTxHash !== null && String(req.wrapTxHash).trim() !== '') {
    if (executor === 'v3-direct') {
      throw routingError(400, 'V3-direct swaps carry no wrap step — refusing a foreign wrap hash.');
    }
    wrapTxHash = assertTxHash('wrapTxHash', req.wrapTxHash);
    const dupWrapFlow = await (prisma as any).flowSwapIntent
      .findUnique({ where: { wrapTxHash } })
      .catch(() => null);
    const dupWrapConv = !dupWrapFlow
      ? await (prisma as any).paymentConversion.findUnique({ where: { wrapTxHash } }).catch(() => null)
      : null;
    if ((dupWrapFlow && dupWrapFlow.id !== row.id) || dupWrapConv) {
      throw routingError(409, 'This wrap transaction is already tracked by another swap or payment.');
    }
  }
  if (executor === 'v3-direct') {
    // Stored rows predate the executor split and can never carry a wrap on
    // mainnet — a non-null stored hash is drift, not evidence.
    if (wrapTxHash) {
      throw routingError(400, 'V3-direct swaps carry no wrap step — refusing a foreign wrap hash.');
    }
  } else if (row.inputSymbol === 'USDC' && !wrapTxHash) {
    throw routingError(400, 'USDC-leg swaps require the WUSDC.deposit wrap transaction hash — broadcast the wrap first.');
  }

  // Atomic claim at registration time too: serialize on both hashes and
  // recheck inside the write transaction so a concurrent verify (Flow or
  // checkout) cannot consume the same tx between our pre-check and persist.
  // Same-tx re-registration for THIS intent stays idempotent. The
  // registration-time checks above remain as fast-path 409s only — the
  // in-transaction rechecks below are the enforcement.
  try {
    return await prisma.$transaction(async (db: any) => {
      await claimTxSlot(db, executionTxHash);
      if (wrapTxHash) await claimTxSlot(db, wrapTxHash);
      await recheckExecutionConsumerTx(db, executionTxHash, { kind: 'flow', id: row.id });
      if (wrapTxHash) await recheckWrapConsumerTx(db, wrapTxHash, { kind: 'flow', id: row.id });
      const live = await db.flowSwapIntent.findUnique({ where: { id: row.id } });
      if (!live) throw routingError(404, 'Swap intent not found.');
      if (live.status === 'EXECUTED') {
        if (live.executionTxHash && live.executionTxHash.toLowerCase() === executionTxHash.toLowerCase()) {
          return live;
        }
        throw routingError(409, 'This swap intent is already consumed.');
      }
      return db.flowSwapIntent.update({
        where: { id: row.id },
        data: { wrapTxHash, executionTxHash },
      });
    });
  } catch (e: any) {
    throw executionConflict(e);
  }
}

// ─── Application: on-chain evidence collection (RPC, then pure verify) ───────

export interface UnitFlowEvidenceBundle {
  evidence: UnitFlowExecutionEvidence;
  payer: string;
  txValue: bigint;
  txTo: string;
  /** Inclusion block of the mined swap (swap-leg; used for wrap ordering). */
  swapBlockNumber: bigint;
}

export async function collectUnitFlowEvidence(args: {
  txHash: string;
  deployment: UnitFlowV3Deployment;
  tokenInSwap: string;
  tokenOutSwap: string;
  amountInSwap: string;
  minOutSwap: string;
  fee: number;
  pool: string;
  recipient: string;
  expectedPayer: string;
  expiresAtSec: number;
  allowSelfPayer: boolean;
  rpcUrl?: string;
}): Promise<UnitFlowEvidenceBundle> {
  const txHash = assertTxHash('txHash', args.txHash);
  const rpcUrl = (args.rpcUrl ?? '').trim() || getNetworkConfig().primaryRpc;
  const client = getRoutingPublicClient(rpcUrl);

  const tx = await readWithRetry('swap tx', () =>
    client.getTransaction({ hash: txHash as `0x${string}` })
  ).catch(() => null);
  if (!tx) throw routingError(404, 'Swap transaction not found on-chain.');
  const receipt = await readWithRetry('swap receipt', () =>
    client.getTransactionReceipt({ hash: txHash as `0x${string}` })
  ).catch(() => null);
  if (!receipt) throw routingError(404, 'Swap transaction receipt not found on-chain.');
  if (receipt.status !== 'success') {
    throw routingError(400, 'Swap transaction reverted on-chain.');
  }

  const decoded = decodeUnitFlowExecute(tx.input, args.deployment);
  const block = await readWithRetry('swap block', () =>
    client.getBlock({ blockHash: receipt.blockHash })
  );
  const txTimestampSec = Number(block.timestamp);
  if (!Number.isInteger(txTimestampSec) || txTimestampSec <= 0) {
    throw routingError(503, 'Could not read execution block timestamp.');
  }

  // Fixed block tags for before/after balances — never assume zero baselines.
  const atBlock = receipt.blockNumber;
  const beforeBlock = atBlock > 0n ? atBlock - 1n : atBlock;
  const tokenOut = assertAddress('tokenOutSwap', args.tokenOutSwap) as `0x${string}`;
  const recipient = assertAddress('recipient', args.recipient) as `0x${string}`;
  const merchantBalanceBefore = (await readWithRetry('recipient balance before', () =>
    client.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [recipient],
      blockNumber: beforeBlock,
    })
  )) as bigint;
  const merchantBalanceAfter = (await readWithRetry('recipient balance after', () =>
    client.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [recipient],
      blockNumber: atBlock,
    })
  )) as bigint;

  // Executor-shaped evidence: universal-router decodes execute() into
  // commands/inputs; v3-direct carries the exactInputSingle calldata in
  // v3Direct with the commands sentinel + empty inputs (the verifier's
  // completeness gate enforces exactly one shape per executor).
  const executor = getUnitFlowExecutor(args.deployment);
  const evidence: UnitFlowExecutionEvidence = {
    deployment: args.deployment,
    txHash,
    to: tx.to ?? '',
    value: (tx as any).value ?? 0n,
    commands: decoded.commands,
    inputs: decoded.inputs as unknown as string[],
    ...(executor === 'v3-direct' ? { v3Direct: tx.input as string } : {}),
    deadline: decoded.deadline,
    payer: tx.from,
    expectedPayer: args.expectedPayer,
    merchantSCA: args.recipient,
    tokenInSwap: args.tokenInSwap,
    tokenOutSwap: args.tokenOutSwap,
    amountInSwap: args.amountInSwap,
    minOutSwap: args.minOutSwap,
    fee: args.fee,
    pool: args.pool,
    expiresAtSec: args.expiresAtSec,
    txTimestampSec,
    merchantBalanceBefore,
    merchantBalanceAfter,
    allowSelfPayer: args.allowSelfPayer,
  };
  return { evidence, payer: tx.from, txValue: BigInt((tx as any).value ?? 0n), txTo: tx.to ?? '', swapBlockNumber: atBlock };
}

export async function checkWrapTxOnChain(args: {
  wrapTxHash: string;
  wusdc: string;
  payer: string;
  amountInSwap: string;
  /** Swap-leg inclusion block: wrap must precede it (validated correlation). */
  swapBlockNumber?: bigint;
  rpcUrl?: string;
}): Promise<void> {
  const wrapTxHash = assertTxHash('wrapTxHash', args.wrapTxHash);
  const rpcUrl = (args.rpcUrl ?? '').trim() || getNetworkConfig().primaryRpc;
  const client = getRoutingPublicClient(rpcUrl);
  const tx = await readWithRetry('wrap tx', () =>
    client.getTransaction({ hash: wrapTxHash as `0x${string}` })
  ).catch(() => null);
  if (!tx) throw routingError(404, 'Wrap transaction not found on-chain.');
  const receipt = await readWithRetry('wrap receipt', () =>
    client.getTransactionReceipt({ hash: wrapTxHash as `0x${string}` })
  ).catch(() => null);
  if (!receipt) throw routingError(404, 'Wrap transaction receipt not found on-chain.');
  checkWrapLinkage(
    {
      wrapTo: tx.to ?? '',
      wrapFrom: tx.from ?? '',
      wrapValue: (BigInt((tx as any).value ?? 0n)).toString(),
      wrapStatus: receipt.status,
    },
    { wusdc: args.wusdc, payer: args.payer, amountInSwap: args.amountInSwap }
  );
  if (args.swapBlockNumber !== undefined) {
    assertWrapBeforeSwap(receipt.blockNumber, args.swapBlockNumber);
  }
}

/**
 * Recompute the execution identity from decoded swap evidence with the exact
 * canonical encoding used at build time, and fail closed when it does not
 * match the stored binding. Both Flow and checkout UnitFlow verification call
 * this — the stored identity is a replay binding only if it is compared.
 */
export function assertExecutionIdentityMatch(stored: unknown, bundle: {
  router: string;
  commands: `0x${string}`;
  inputs: [`0x${string}`];
  deadline: bigint;
}): void {
  if (typeof stored !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(stored)) {
    throw routingError(500, '[unitflow-v3] stored execution identity missing or malformed — refusing.');
  }
  const recomputed = computeUnitFlowExecutionIdentity({
    router: bundle.router,
    commands: bundle.commands,
    v3input: bundle.inputs[0]!,
    deadline: bundle.deadline,
  });
  if (recomputed.toLowerCase() !== stored.toLowerCase()) {
    throw routingError(403, '[unitflow-v3] execution identity mismatch — decoded execution != quoted binding.');
  }
}

// ─── Application: Flow Swap verify ───────────────────────────────────────────

export interface VerifyFlowRequest extends IntentLocator {
  ownerWallet: string;
  wrapTxHash?: string | null;
  executionTxHash?: string | null;
  rpcUrl?: string;
}

export async function verifyFlowSwap(req: VerifyFlowRequest): Promise<{
  alreadySettled: boolean;
  intent: any;
  payer: string;
  actualInput: string;
  actualOutput: string;
}> {
  const ownerWallet = assertAddress('ownerWallet', req.ownerWallet);
  let row = await loadFlowIntent(ownerWallet, req);
  if (row.status === 'EXECUTED') {
    // Resume: same execution tx re-verifies idempotently; a different tx
    // against a consumed intent is a replay.
    const resumeTx = (req.executionTxHash ?? row.executionTxHash ?? '').trim();
    if (resumeTx !== '' && row.executionTxHash && resumeTx.toLowerCase() === row.executionTxHash.toLowerCase()) {
      return {
        alreadySettled: true,
        intent: row,
        payer: row.expectedPayer,
        actualInput: row.actualInputAmount ?? row.inputAmount,
        actualOutput: row.actualOutputAmount ?? '0',
      };
    }
    throw routingError(409, 'This swap intent is already consumed.');
  }
  await assertIntentLive(row);

  const executionTxHash = ((req.executionTxHash ?? row.executionTxHash ?? '') as string).trim();
  if (!executionTxHash) {
    throw routingError(400, 'executionTxHash is required — register the broadcast swap first.');
  }
  assertTxHash('executionTxHash', executionTxHash);
  const consumed = await findExecutionConsumer(executionTxHash);
  if (consumed && !(consumed.kind === 'flow' && consumed.id === row.id)) {
    throw routingError(409, 'This transaction was already consumed by another swap or payment.');
  }

  // Deployment is network-global (ARC_NETWORK); the rpcUrl request field
  // is the only per-call override. Drift vs the stored binding fails closed.
  const deployment = getUnitFlowV3Deployment();
  if (deployment.name !== row.deploymentName || deployment.universalRouter.toLowerCase() !== String(row.deploymentRouter).toLowerCase()) {
    throw routingError(503, '[unitflow-v3] deployment drift — stored binding does not match the atomic family. Refusing.');
  }

  const expiresAtSec = Math.floor(new Date(row.quoteExpiresAt).getTime() / 1000);
  const { evidence, payer, swapBlockNumber } = await collectUnitFlowEvidence({
    txHash: executionTxHash,
    deployment,
    tokenInSwap: row.tokenInSwap,
    tokenOutSwap: row.tokenOutSwap,
    amountInSwap: row.inputAmountSwap,
    minOutSwap: row.minOutputSwap,
    fee: row.feeTier,
    pool: row.poolAddress,
    recipient: row.recipient,
    expectedPayer: row.expectedPayer,
    expiresAtSec,
    allowSelfPayer: true,
    rpcUrl: req.rpcUrl,
  });

  // Explicit payer binding: the mined payer MUST be the session wallet.
  // No default, no fallback, no inference.
  if (payer.toLowerCase() !== ownerWallet.toLowerCase()) {
    throw routingError(403, 'Swap payer does not match the authenticated wallet — refusing.');
  }

  const verified = verifyUnitFlowExecution(evidence);
  assertExecutionIdentityMatch(row.executionIdentity, {
    router: deployment.universalRouter,
    commands: evidence.commands as `0x${string}`,
    inputs: (evidence.inputs as string[]).slice(0, 1) as [`0x${string}`],
    deadline: BigInt(evidence.deadline as any),
  });

  // Executor-aware wrap linkage. Universal-router (testnet): the USDC-leg
  // wrap is a separate tx, explicitly linked — never assumed. Validated
  // correlation only (see header + checkWrapTxOnChain): matching receipt +
  // wrap-before-swap ordering, never cryptographic funding proof.
  // V3-direct (mainnet): NO wrap exists (native USDC leg) — a supplied wrap
  // hash is rejected outright so a stale testnet-shaped caller can never
  // satisfy a mainnet intent with a foreign wrap.
  const executor = getUnitFlowExecutor(deployment);
  let wrapTxHash: string | null = ((req.wrapTxHash ?? row.wrapTxHash ?? '') as string).trim() || null;
  if (executor === 'v3-direct') {
    if (wrapTxHash) {
      throw routingError(400, 'V3-direct swaps carry no wrap step — refusing a foreign wrap hash.');
    }
  } else if (row.inputSymbol === 'USDC') {
    if (!wrapTxHash) {
      throw routingError(400, 'USDC-leg swaps require the WUSDC.deposit wrap transaction hash.');
    }
    await checkWrapTxOnChain({
      wrapTxHash,
      wusdc: deployment.wusdc,
      payer,
      amountInSwap: row.inputAmountSwap,
      swapBlockNumber,
      rpcUrl: req.rpcUrl,
    });
  }

  const actualInput = canonicalFromSwapUnits(row.inputSymbol as SwapSymbol, verified.inputAmount, deployment).toString();
  // TESTNET USDC-output swaps settle in dust-inclusive WUSDC swap units: the
  // Quoter's 18-dec output is essentially never 1e12-aligned, so an exact
  // rescale is impossible (canonicalFromSwapUnits throws by design —
  // alignment IS required on the input/wrap direction). Floor to canonical
  // micro-USDC instead: dust < 1e-6 USDC stays in the wallet as WUSDC (still
  // owned by the user, never claimed), and the unwrap exit burns exactly
  // this floored amount, keeping every downstream exact equation intact.
  // V3-direct (mainnet) USDC legs are 6-dec identity — no dust can exist.
  let actualOutput: string;
  if ((row.outputSymbol as SwapSymbol) === 'USDC' && executor !== 'v3-direct') {
    const floored = verified.actualOutput - (verified.actualOutput % UNITFLOW_6_TO_18_SCALE);
    if (floored <= 0n) {
      throw routingError(503, '[unitflow-v3] USDC-leg output below one micro-USDC — refusing.');
    }
    actualOutput = (floored / UNITFLOW_6_TO_18_SCALE).toString();
  } else {
    actualOutput = canonicalFromSwapUnits(row.outputSymbol as SwapSymbol, verified.actualOutput, deployment).toString();
  }

  // Atomic claim: per-hash advisory lock + in-transaction cross-table recheck
  // (execution + wrap). First committer wins — even under a Flow-vs-checkout
  // race the loser sees 409 here, never a double-settle. Same-tx resume for
  // THIS row stays idempotent via the recheck's self exemption; any unique
  // violation at commit maps to 409 as well.
  try {
    const intent = await prisma.$transaction(async (db: any) => {
      await claimTxSlot(db, executionTxHash);
      if (wrapTxHash) await claimTxSlot(db, wrapTxHash);
      await recheckExecutionConsumerTx(db, executionTxHash, { kind: 'flow', id: row.id });
      if (wrapTxHash) await recheckWrapConsumerTx(db, wrapTxHash, { kind: 'flow', id: row.id });
      const live = await db.flowSwapIntent.findUnique({ where: { id: row.id } });
      if (!live) throw routingError(404, 'Swap intent not found.');
      if (live.status === 'EXECUTED') {
        // Same-tx resume that slipped past the early return (row EXECUTED
        // between load and claim): idempotent only for THIS row's own tx.
        if (live.executionTxHash && live.executionTxHash.toLowerCase() === executionTxHash.toLowerCase()) {
          return { row: live, resumed: true };
        }
        throw routingError(409, 'This swap intent is already consumed.');
      }
      const updated = await db.flowSwapIntent.update({
        where: { id: row.id },
        data: {
          status: 'EXECUTED',
          executionTxHash,
          wrapTxHash,
          actualInputAmount: actualInput,
          actualOutputAmount: actualOutput,
        },
      });
      return { row: updated, resumed: false };
    });
    return { alreadySettled: intent.resumed, intent: intent.row, payer, actualInput, actualOutput };
  } catch (e: any) {
    throw executionConflict(e);
  }
}

// ─── Application: Flow Swap unwrap (TESTNET WUSDC -> native USDC exit) ───────
// The TESTNET UnitFlow V3 pools settle the USDC leg in WUSDC, so a verified
// testnet Flow Swap into USDC credits WUSDC first. The user-facing settlement
// is completed by ONE further unsigned wallet transaction — WUSDC.withdraw
// (wad) — that burns the caller's WUSDC 1:1 into native USDC (the same asset
// the 0x3600… 6-dec ERC-20 balance view reports, so post-unwrap balance
// refreshes just work).
//
// On v3-direct (mainnet) the USDC leg IS native USDC — this whole section
// refuses fail-closed (flowNeedsUnwrap() is false, unwrapAmountSwapForIntent()
// throws, request/verify unwrap throw before any RPC).
//
// Rules (fail-closed, server-resolved, stateless):
// - The unwrap amount is NEVER client-supplied: it is exactly the verified
//   swap proceeds (EXECUTED intent actualOutputAmount, canonical 6-dec,
//   rescaled ×1e12 to swap-leg units). Partial or foreign amounts fail.
// - The unwrap tx is unsigned server output only (to = canonical WUSDC,
//   value = 0, withdraw selector); the user's wallet signs and broadcasts.
// - Verification is evidence-based: tx.to is the canonical WUSDC contract,
//   tx.from is the session wallet, calldata decodes to withdraw(exact wad),
//   the receipt succeeded, the unwrap is ordered after the swap execution
//   (block + transactionIndex), and the native balance delta at fixed block
//   tags covers the unwrapped amount. No DB write, no migration surface:
//   the EXECUTED swap row already carries the authoritative actuals, and an
//   unwrap burns the caller's own WUSDC — replaying it reverts on-chain
//   (insufficient balance) instead of double-settling anything.
// - Only USDC-output intents need this step. USDC inputs (wrap) and EURC
//   outputs are untouched.

/**
 * True when a Flow intent settles into USDC and needs the unwrap exit step.
 * Executor-aware: the unwrap exit exists ONLY on universal-router deployments
 * (testnet WUSDC leg). On v3-direct (mainnet native USDC) the swap settles
 * the canonical token itself — always false, never a wrap/unwrap path.
 */
export function flowNeedsUnwrap(row: { outputSymbol: string; deploymentName?: string }): boolean {
  if (String(row.outputSymbol ?? '').toUpperCase() !== 'USDC') return false;
  // Deployment binding is authoritative when present. Deployment names flow
  // from getUnitFlowV3Deployment() only (never client input); unknown names
  // fail OPEN is forbidden — default to the conservative testnet shape (wrap
  // required) unless the row is explicitly bound to mainnet.
  if (!row.deploymentName) return true;
  return String(row.deploymentName).toLowerCase() !== 'mainnet';
}

/**
 * Exact unwrap amount in swap-leg units for an EXECUTED USDC-output intent.
 * Throws fail-closed unless the swap itself is already verified on-chain
 * (actualOutputAmount is set only by verifyFlowSwap after proof).
 */
export function unwrapAmountSwapForIntent(row: any): bigint {
  if (!flowNeedsUnwrap(row ?? {})) {
    throw routingError(400, 'This swap settles directly — no unwrap step is needed.');
  }
  const deployment = getUnitFlowV3Deployment();
  if (getUnitFlowExecutor(deployment) === 'v3-direct') {
    // Defense in depth: even if a caller passes a legacy-shaped row, the
    // CURRENT network executor settles native USDC — no unwrap exists.
    throw routingError(400, 'This swap settles directly — no unwrap step is needed.');
  }
  if (row.status !== 'EXECUTED') {
    throw routingError(409, 'Verify the swap on-chain first — the unwrap amount is the verified output.');
  }
  let canonical: bigint;
  try {
    canonical = BigInt(String(row.actualOutputAmount ?? ''));
  } catch {
    throw routingError(500, '[unitflow-v3] verified output missing — refusing to build unwrap.');
  }
  if (canonical <= 0n) {
    throw routingError(500, '[unitflow-v3] verified output missing — refusing to build unwrap.');
  }
  return canonical * UNITFLOW_6_TO_18_SCALE;
}

export interface RequestFlowUnwrapRequest extends IntentLocator {
  ownerWallet: string;
}

/**
 * Build the unsigned WUSDC.withdraw unwrap transaction for a verified
 * USDC-output swap. Server-resolved amount/recipient; nothing is signed.
 */
export async function requestFlowUnwrap(req: RequestFlowUnwrapRequest): Promise<{
  intentId: string;
  unwrapTx: UnsignedTxJson;
  /** Exact withdraw wad, swap-leg units (18-dec). */
  amountSwap: string;
  /** Expected final native USDC credit, canonical 6-dec units. */
  finalReceived: string;
}> {
  const ownerWallet = assertAddress('ownerWallet', req.ownerWallet);
  const row = await loadFlowIntent(ownerWallet, req);
  const deployment = getUnitFlowV3Deployment();
  if (deployment.name !== row.deploymentName || deployment.wusdc.toLowerCase() !== String(row.tokenOutSwap ?? '').toLowerCase()) {
    throw routingError(503, '[unitflow-v3] deployment drift — stored binding does not match the atomic family. Refusing.');
  }
  // V3-direct (mainnet native USDC) has no unwrap exit — refuse before
  // building any tx so a stale testnet-shaped caller can never unwrap
  // mainnet proceeds.
  if (getUnitFlowExecutor(deployment) === 'v3-direct') {
    throw routingError(400, 'This swap settles directly — no unwrap step is needed.');
  }
  const amountSwap = unwrapAmountSwapForIntent(row);
  const tx = buildWusdcWithdrawTx(deployment.wusdc, amountSwap);
  return {
    intentId: row.id,
    unwrapTx: txJson(tx),
    amountSwap: amountSwap.toString(),
    finalReceived: String(row.actualOutputAmount),
  };
}

export interface VerifyFlowUnwrapRequest extends IntentLocator {
  ownerWallet: string;
  unwrapTxHash: string;
  rpcUrl?: string;
}

/**
 * Prove the unwrap on-chain: exact-withdraw calldata from the session wallet
 * to the canonical WUSDC contract, mined successfully after the swap, with
 * the native USDC balance delta covering the verified proceeds. Stateless —
 * returns the final received USDC (canonical units) without writing.
 */
export async function verifyFlowUnwrap(req: VerifyFlowUnwrapRequest): Promise<{
  intentId: string;
  payer: string;
  finalReceived: string;
  unwrapTxHash: string;
}> {
  const ownerWallet = assertAddress('ownerWallet', req.ownerWallet);
  const unwrapTxHash = assertTxHash('unwrapTxHash', req.unwrapTxHash);
  const row = await loadFlowIntent(ownerWallet, req);

  const deployment = getUnitFlowV3Deployment();
  if (deployment.name !== row.deploymentName || deployment.wusdc.toLowerCase() !== String(row.tokenOutSwap ?? '').toLowerCase()) {
    throw routingError(503, '[unitflow-v3] deployment drift — stored binding does not match the atomic family. Refusing.');
  }
  // V3-direct (mainnet native USDC) has no unwrap exit — refuse before any
  // RPC so a stale testnet-shaped caller can never verify an unwrap on
  // mainnet proceeds.
  if (getUnitFlowExecutor(deployment) === 'v3-direct') {
    throw routingError(400, 'This swap settles directly — no unwrap step is needed.');
  }
  const expectedSwap = unwrapAmountSwapForIntent(row);

  const rpcUrl = (req.rpcUrl ?? '').trim() || getNetworkConfig().primaryRpc;
  const client = getRoutingPublicClient(rpcUrl);

  const tx = await readWithRetry('unwrap tx', () =>
    client.getTransaction({ hash: unwrapTxHash as `0x${string}` })
  ).catch(() => null);
  if (!tx) throw routingError(404, 'Unwrap transaction not found on-chain.');
  const receipt = await readWithRetry('unwrap receipt', () =>
    client.getTransactionReceipt({ hash: unwrapTxHash as `0x${string}` })
  ).catch(() => null);
  if (!receipt) throw routingError(404, 'Unwrap transaction receipt not found on-chain.');
  if (receipt.status !== 'success') {
    throw routingError(400, 'Unwrap transaction reverted on-chain.');
  }

  // Linkage: canonical WUSDC destination, session-wallet sender, zero value
  // (withdraw carries no native value — unlike the wrap deposit), exact wad.
  const eq = (a: string, b: string) => a?.toLowerCase() === b?.toLowerCase();
  if (!eq(tx.to ?? '', deployment.wusdc)) {
    throw routingError(403, '[unitflow-v3] unwrap linkage failed — destination is not the canonical WUSDC contract.');
  }
  if (!eq(tx.from ?? '', ownerWallet)) {
    throw routingError(403, 'Unwrap sender does not match the authenticated wallet — refusing.');
  }
  if (BigInt((tx as any).value ?? 0n) !== 0n) {
    throw routingError(403, '[unitflow-v3] unwrap linkage failed — withdraw must carry zero native value.');
  }
  const wad = decodeWusdcWithdraw(tx.input);
  if (wad !== expectedSwap) {
    throw routingError(403, '[unitflow-v3] unwrap amount != verified swap proceeds — refusing.');
  }

  // Ordering: the unwrap must settle after the swap execution (same-block
  // unwrap is ordered by transactionIndex — no false rejection).
  const swapReceipt = await readWithRetry('swap receipt for unwrap ordering', () =>
    client.getTransactionReceipt({ hash: String(row.executionTxHash) as `0x${string}` })
  ).catch(() => null);
  if (!swapReceipt) throw routingError(404, 'Swap execution receipt not found on-chain.');
  const unwrapBlock = receipt.blockNumber;
  const swapBlock = swapReceipt.blockNumber;
  const ordered =
    unwrapBlock > swapBlock ||
    (unwrapBlock === swapBlock && receipt.transactionIndex > swapReceipt.transactionIndex);
  if (!ordered) {
    throw routingError(403, '[unitflow-v3] unwrap ordering failed — unwrap must settle after the swap.');
  }

  // Settlement proof (gas-aware, exact equations at fixed block tags).
  // Gas is paid in the SAME native asset the withdraw credits, so the raw
  // native delta is short by exactly gasUsed x effectiveGasPrice (verified
  // live on a main-history withdraw: delta + gasCost == wad to the wei).
  // Both equations must hold:
  //   (a) WUSDC.balanceOf(owner) decreases by exactly the wad (burn proof —
  //       gas-free, since gas is native and WUSDC is a separate token);
  //   (b) native delta + actual gas cost equals the wad exactly (receipt
  //       proof — the user net-received the verified proceeds).
  // Together with the calldata/linkage/ordering checks above, an arbitrary
  // native credit or a foreign withdraw can never satisfy this.
  const owner = assertAddress('ownerWallet', ownerWallet) as `0x${string}`;
  const beforeBlock = unwrapBlock > 0n ? unwrapBlock - 1n : unwrapBlock;
  const wusdc = deployment.wusdc as `0x${string}`;
  const wusdcBefore = (await readWithRetry('WUSDC balance before unwrap', () =>
    client.readContract({
      address: wusdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      blockNumber: beforeBlock,
    })
  )) as bigint;
  const wusdcAfter = (await readWithRetry('WUSDC balance after unwrap', () =>
    client.readContract({
      address: wusdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      blockNumber: unwrapBlock,
    })
  )) as bigint;
  if (wusdcBefore < wusdcAfter || wusdcBefore - wusdcAfter !== expectedSwap) {
    throw routingError(403, '[unitflow-v3] unwrap settlement not proven — WUSDC burn delta != verified proceeds.');
  }
  const nativeBefore = (await readWithRetry('native balance before unwrap', () =>
    client.getBalance({ address: owner, blockNumber: beforeBlock })
  )) as bigint;
  const nativeAfter = (await readWithRetry('native balance after unwrap', () =>
    client.getBalance({ address: owner, blockNumber: unwrapBlock })
  )) as bigint;
  const gasPriceRaw = (receipt as any).effectiveGasPrice ?? (tx as any).gasPrice ?? (tx as any).maxFeePerGas;
  let gasPrice: bigint | null = null;
  try {
    gasPrice = BigInt(gasPriceRaw);
  } catch {
    gasPrice = null;
  }
  if (gasPrice === null || gasPrice < 0n) {
    throw routingError(503, '[unitflow-v3] unwrap settlement not provable — gas price unavailable.');
  }
  const gasCost = BigInt(receipt.gasUsed) * gasPrice;
  if (nativeAfter < nativeBefore || nativeAfter - nativeBefore + gasCost !== expectedSwap) {
    throw routingError(403, '[unitflow-v3] unwrap settlement not proven — native receipt != verified proceeds.');
  }

  return { intentId: row.id, payer: tx.from, finalReceived: String(row.actualOutputAmount), unwrapTxHash };
}

// ─── Application: merchant-checkout UnitFlow branch ──────────────────────────
// Canonical checkout behavior is preserved verbatim when venue=canonical
// (the quoter/verifier path is untouched). This branch is selected ONLY via
// resolveCheckoutVenueId('unitflow-v3') — explicit opt-in + enabled flag.

export interface CheckoutUnitFlowQuoteRequest {
  payment: any;
  payTokenSymbol: SwapSymbol;
  /** 0x sender hint when the payment already names a payer (may be null). */
  senderHint?: string | null;
  env?: Record<string, string | undefined>;
}

export interface CheckoutUnitFlowQuote {
  converted: true;
  venueId: 'unitflow-v3';
  reference: string;
  payToken: { symbol: string; address: string; decimals: number };
  settlementToken: { symbol: string; address: string; decimals: number };
  inputAmount: string;
  quotedOutputAmount: string;
  minOutputAmount: string;
  quoteExpiresAt: string;
  deadline: number;
  quoteHash: string;
  pool: string;
  feeTier: number;
  deploymentName: string;
  router: string;
  recipient: string;
  slippageBps: number;
  idempotencyKey: string;
}

export async function requestCheckoutUnitFlowQuote(
  req: CheckoutUnitFlowQuoteRequest
): Promise<CheckoutUnitFlowQuote> {
  const env = req.env ?? process.env;
  getSwapRegistry(env).selectProvider('unitflow-v3', env);

  const payment = req.payment;
  const reference = String(payment.reference ?? '').trim();
  if (!reference) throw routingError(400, 'Payment reference is required.');

  // v1 scope gate: UnitFlow checkout settles EURC invoices paid in USDC.
  // Every other direction stays on the canonical router (or direct pay).
  const settlement = resolveRowCurrency({
    currency: payment.currency ?? null,
    tokenAddress: payment.tokenAddress ?? null,
  });
  if (req.payTokenSymbol !== CHECKOUT_UNITFLOW_INPUT || settlement.symbol !== CHECKOUT_UNITFLOW_OUTPUT) {
    throw routingError(
      400,
      `UnitFlow checkout v1 supports ${CHECKOUT_UNITFLOW_INPUT}→${CHECKOUT_UNITFLOW_OUTPUT} only — use the canonical quote for other directions.`
    );
  }

  const payToken = getTokenBySymbol(req.payTokenSymbol);
  const merchantSCA = assertAddress('merchantSCA', payment.merchantSCA);
  const invoiceBase = parseUnits(Number(payment.amount).toFixed(settlement.decimals), settlement.decimals);
  if (invoiceBase <= 0n) throw routingError(400, 'Invoice amount must be positive.');

  const deployment = getUnitFlowV3Deployment(env);
  const slippageBps = ROUTING_SLIPPAGE_BPS;
  const expiresAtSec = Math.floor(Date.now() / 1000) + Math.floor(ROUTING_QUOTE_TTL_MS / 1000);
  const quoteExpiresAt = new Date(expiresAtSec * 1000);
  const senderHint =
    req.senderHint && ADDRESS_RE.test(req.senderHint.trim()) ? req.senderHint.trim() : undefined;

  // Size the exact input: start at invoice parity (stables ~1:1) and bump
  // until the live Quoter output covers the invoice after slippage + the
  // canonical out-fee buffer. Each probe is RPC reads only (no signing).
  let envelope: UnitFlowV3ExecutionEnvelope | null = null;
  let input = invoiceBase + ROUTING_OUT_FEE_BUFFER[CHECKOUT_UNITFLOW_OUTPUT];
  for (let i = 0; i < CHECKOUT_INPUT_SEARCH_MAX; i++) {
    const probe = await buildUnitFlowV3Execution(
      {
        inputSymbol: CHECKOUT_UNITFLOW_INPUT,
        outputSymbol: CHECKOUT_UNITFLOW_OUTPUT,
        inputAmount: input,
        merchantSCA,
        ...(senderHint ? { expectedPayer: senderHint } : {}),
        slippageBps,
        expiresAtSec,
      },
      env
    );
    if (probe.minOutSwap >= invoiceBase) {
      envelope = probe;
      break;
    }
    input += input / 200n + 1n;
  }
  if (!envelope) {
    throw routingError(503, '[unitflow-v3] pool cannot cover this invoice after slippage — try the canonical route.');
  }

  const quoteHash = computeSwapQuoteHash({
    scope: 'checkout',
    bindingRef: reference,
    venueId: 'unitflow-v3',
    deploymentName: deployment.name,
    inputToken: payToken.address,
    inputAmount: envelope.inputAmountCanonical,
    outputToken: settlement.address,
    quotedOutputSwap: envelope.quotedOutputSwap,
    minOutSwap: envelope.minOutSwap,
    pool: envelope.pool,
    fee: envelope.fee,
    expiresAtSec,
    recipient: merchantSCA,
    expectedPayer: senderHint ?? '',
  });
  const idempotencyKey = swapIdempotencyKey('quote', String(payment.id), quoteHash);

  // Single live conversion per payment (same resume/expire discipline as
  // the canonical quoter). EXPIRED rows stay as history.
  const existing = await (prisma as any).paymentConversion.findUnique({
    where: { paymentLogId: payment.id },
  });
  if (existing) {
    if (existing.status === 'EXECUTED') {
      throw routingError(409, 'This payment was already converted — the quote is consumed.');
    }
    if (existing.status === 'QUOTED' && new Date(existing.quoteExpiresAt).getTime() > Date.now()) {
      return conversionToUnitFlowQuote(existing, reference, payToken, settlement, merchantSCA, deployment.universalRouter);
    }
    if (existing.status === 'QUOTED') {
      await (prisma as any).paymentConversion.update({
        where: { id: existing.id },
        data: { status: 'EXPIRED' },
      });
    }
    await (prisma as any).paymentConversion.deleteMany({
      where: { paymentLogId: payment.id, status: 'EXPIRED' },
    });
  }

  try {
    const created = await prisma.$transaction(async (tx: any) => {
      await tx.paymentLog.update({
        where: { id: payment.id },
        data: { payTokenAddress: payToken.address },
      });
      // v1 scope is EURC-out, whose swap-leg units ARE canonical 6-dec
      // units — so quotedOutputSwap/minOutSwap persist verbatim into the
      // canonical-named columns with no rescale. (A future USDC-out scope
      // must convert via canonicalFromSwapUnits here.)
      return tx.paymentConversion.create({
        data: {
          paymentLogId: payment.id,
          status: 'QUOTED',
          inputTokenAddress: payToken.address,
          inputAmount: envelope!.inputAmountCanonical.toString(),
          outputTokenAddress: settlement.address,
          quotedOutputAmount: envelope!.quotedOutputSwap.toString(),
          minOutputAmount: envelope!.minOutSwap.toString(),
          quoteExpiresAt,
          quoteHash,
          poolAddress: envelope!.pool,
          idempotencyKey,
          venueId: 'unitflow-v3',
          deploymentName: deployment.name,
          deploymentRouter: deployment.universalRouter,
          feeTier: envelope!.fee,
          executionIdentity: envelope!.executionIdentity,
          ...(senderHint ? { expectedPayer: senderHint } : {}),
          slippageBps,
          tokenInSwap: envelope!.tokenInSwap,
          tokenOutSwap: envelope!.tokenOutSwap,
          amountInSwap: envelope!.amountInSwap.toString(),
          quotedOutputSwap: envelope!.quotedOutputSwap.toString(),
          minOutputSwap: envelope!.minOutSwap.toString(),
        },
      });
    });
    return conversionToUnitFlowQuote(created, reference, payToken, settlement, merchantSCA, deployment.universalRouter);
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const winner = await (prisma as any).paymentConversion.findUnique({
        where: { paymentLogId: payment.id },
      });
      if (winner && winner.status === 'QUOTED' && new Date(winner.quoteExpiresAt).getTime() > Date.now()) {
        return conversionToUnitFlowQuote(winner, reference, payToken, settlement, merchantSCA, deployment.universalRouter);
      }
    }
    throw e;
  }
}

function conversionToUnitFlowQuote(
  row: any,
  reference: string,
  payToken: { symbol: string; address: string; decimals: number },
  settlement: { symbol: string; address: string; decimals: number },
  recipient: string,
  router: string
): CheckoutUnitFlowQuote {
  return {
    converted: true,
    venueId: 'unitflow-v3',
    reference,
    payToken: { ...payToken },
    settlementToken: { ...settlement },
    inputAmount: row.inputAmount,
    quotedOutputAmount: row.quotedOutputAmount,
    minOutputAmount: row.minOutputAmount,
    quoteExpiresAt: new Date(row.quoteExpiresAt).toISOString(),
    deadline: Math.floor(new Date(row.quoteExpiresAt).getTime() / 1000),
    quoteHash: row.quoteHash,
    pool: row.poolAddress,
    feeTier: row.feeTier,
    deploymentName: row.deploymentName,
    router,
    recipient,
    slippageBps: row.slippageBps,
    idempotencyKey: row.idempotencyKey,
  };
}

// ─── Application: merchant-checkout UnitFlow verify ──────────────────────────

export interface CheckoutUnitFlowVerifyRequest {
  payment: any;
  conversion: any;
  txHash: string;
  wrapTxHash?: string | null;
  /** 0x sender hint already recorded on the payment (may be null). */
  senderHint?: string | null;
  /** Resume flag: same-tx resubmission after a crash between EXECUTED/SUCCESS. */
  allowExecutedResume?: boolean;
  env?: Record<string, string | undefined>;
  rpcUrl?: string;
}

export interface CheckoutUnitFlowVerified {
  payment: any;
  payer: string;
  actualInput: string;
  actualOutput: string;
}

export async function verifyCheckoutUnitFlow(
  req: CheckoutUnitFlowVerifyRequest
): Promise<CheckoutUnitFlowVerified> {
  const env = req.env ?? process.env;
  getSwapRegistry(env).selectProvider('unitflow-v3', env);
  const txHash = assertTxHash('txHash', req.txHash);
  const { payment, conversion } = req;

  if (!conversion || conversion.venueId !== 'unitflow-v3') {
    throw routingError(400, 'This payment is not bound to a UnitFlow conversion quote.');
  }
  if (conversion.status === 'EXECUTED' && !req.allowExecutedResume) {
    throw routingError(409, 'This conversion quote is already consumed.');
  }
  if (conversion.status !== 'QUOTED' && !(conversion.status === 'EXECUTED' && req.allowExecutedResume)) {
    throw routingError(400, 'This conversion quote is no longer live — request a fresh quote.');
  }
  if (new Date(conversion.quoteExpiresAt).getTime() <= Date.now() && !req.allowExecutedResume) {
    throw routingError(410, 'Conversion quote expired before execution — request a fresh quote.');
  }

  const settlement = resolveRowCurrency({
    currency: payment.currency ?? null,
    tokenAddress: payment.tokenAddress ?? null,
  });
  const merchantSCA = assertAddress('merchantSCA', payment.merchantSCA);
  const deployment = getUnitFlowV3Deployment(env);
  if (
    conversion.deploymentName !== deployment.name ||
    String(conversion.deploymentRouter ?? '').toLowerCase() !== deployment.universalRouter.toLowerCase()
  ) {
    throw routingError(503, '[unitflow-v3] deployment drift — stored binding does not match the atomic family. Refusing.');
  }

  const expiresAtSec = Math.floor(new Date(conversion.quoteExpiresAt).getTime() / 1000);

  // Permissionless checkout: no session payer exists, so the mined tx payer
  // is peeked first (single cheap tx read), gated, then bound into the one
  // full evidence collection below. The pure verifier's payer ==
  // expectedPayer check is therefore always non-vacuous, and it still
  // rejects router/zero/merchant substitutes on its own.
  const peekClient = getRoutingPublicClient((req.rpcUrl ?? '').trim() || getNetworkConfig().primaryRpc);
  const peeked = await readWithRetry('swap tx payer', () =>
    peekClient.getTransaction({ hash: txHash as `0x${string}` })
  ).catch(() => null);
  if (!peeked) throw routingError(404, 'Swap transaction not found on-chain.');
  const payer = peeked.from;

  // Sender-hint safeguard (existing checkout convention): a payment that
  // already names its payer only settles from that payer.
  const hint = (req.senderHint ?? '').trim();
  if (hint.startsWith('0x') && payer.toLowerCase() !== hint.toLowerCase()) {
    throw routingError(403, 'Swap payer does not match the payment payer.');
  }
  if (conversion.expectedPayer && payer.toLowerCase() !== String(conversion.expectedPayer).toLowerCase()) {
    throw routingError(403, 'Swap payer does not match the bound conversion payer.');
  }

  const { evidence: bound, swapBlockNumber } = await collectUnitFlowEvidence({
    txHash,
    deployment,
    tokenInSwap: conversion.tokenInSwap,
    tokenOutSwap: conversion.tokenOutSwap,
    amountInSwap: conversion.amountInSwap,
    minOutSwap: conversion.minOutputSwap,
    fee: conversion.feeTier,
    pool: conversion.poolAddress,
    recipient: merchantSCA,
    expectedPayer: conversion.expectedPayer ?? payer,
    expiresAtSec,
    allowSelfPayer: false,
    rpcUrl: req.rpcUrl,
  });
  const verified = verifyUnitFlowExecution(bound);
  assertExecutionIdentityMatch(conversion.executionIdentity, {
    router: deployment.universalRouter,
    commands: bound.commands as `0x${string}`,
    inputs: (bound.inputs as string[]).slice(0, 1) as [`0x${string}`],
    deadline: BigInt(bound.deadline as any),
  });

  // Executor-aware wrap linkage (checkout UnitFlow v1 is always USDC in).
  // Universal-router (testnet): validated correlation only — matching
  // receipt + wrap-before-swap ordering, never a claim that the wrap funded
  // the swap (separate transactions). V3-direct (mainnet): NO wrap exists
  // (native USDC leg) — a supplied wrap hash is rejected outright.
  const checkoutExecutor = getUnitFlowExecutor(deployment);
  const wrapTxHash = ((req.wrapTxHash ?? conversion.wrapTxHash ?? '') as string).trim() || null;
  if (checkoutExecutor === 'v3-direct') {
    if (wrapTxHash) {
      throw routingError(400, 'V3-direct conversions carry no wrap step — refusing a foreign wrap hash.');
    }
  } else {
    if (!wrapTxHash) {
      throw routingError(400, 'USDC-leg conversions require the WUSDC.deposit wrap transaction hash.');
    }
    await checkWrapTxOnChain({
      wrapTxHash,
      wusdc: deployment.wusdc,
      payer,
      amountInSwap: conversion.amountInSwap,
      swapBlockNumber,
      rpcUrl: req.rpcUrl,
    });
  }

  // Exact-in binding: the pure verifier already proved decoded amountIn ==
  // the stored swap-leg input, which was derived from conversion.inputAmount.
  const actualInputCanonical = conversion.inputAmount as string;
  const actualOutputCanonical = canonicalFromSwapUnits(
    CHECKOUT_UNITFLOW_OUTPUT,
    verified.actualOutput,
    deployment
  ).toString();

  // Atomic: conversion EXECUTED + payment SUCCESS (same shape as the
  // canonical path's successData — currency/tokenAddress preserved).
  const successData = {
    status: 'SUCCESS',
    arcTxHash: txHash,
    payerSCA: payer,
    senderEmail: payer,
    currency: settlement.symbol,
    tokenAddress: settlement.address,
  };
  // Atomic: per-hash advisory lock + in-transaction cross-table recheck, then
  // conversion EXECUTED + payment SUCCESS (same shape as the canonical path's
  // successData — currency/tokenAddress preserved). Flow-vs-checkout races
  // serialize on the execution lock: one wins, the other gets 409. Resume for
  // THIS conversion (allowExecutedResume) stays idempotent; commit-time unique
  // violations map to 409.
  let updated: any;
  try {
    updated = await prisma.$transaction(async (db: any) => {
      await claimTxSlot(db, txHash);
      if (wrapTxHash) await claimTxSlot(db, wrapTxHash);
      await recheckExecutionConsumerTx(db, txHash, { kind: 'checkout', paymentLogId: payment.id });
      if (wrapTxHash) await recheckWrapConsumerTx(db, wrapTxHash, { kind: 'checkout', paymentLogId: payment.id });
      const live = await db.paymentConversion.findUnique({ where: { id: conversion.id } });
      if (!live) throw routingError(404, 'Conversion not found.');
      if (live.status === 'EXECUTED') {
        if (!req.allowExecutedResume) {
          throw routingError(409, 'This conversion quote is already consumed.');
        }
        if (live.executionTxHash && live.executionTxHash.toLowerCase() === txHash.toLowerCase()) {
          return db.paymentLog.findUnique({ where: { id: payment.id } });
        }
        throw routingError(409, 'This conversion quote is already consumed.');
      }
      await db.paymentConversion.update({
        where: { id: conversion.id },
        data: {
          status: 'EXECUTED',
          executionTxHash: txHash,
          wrapTxHash,
          expectedPayer: payer,
          actualInputAmount: actualInputCanonical,
          actualOutputAmount: actualOutputCanonical,
        },
      });
      return db.paymentLog.update({ where: { id: payment.id }, data: successData });
    });
  } catch (e: any) {
    throw executionConflict(e);
  }
  return { payment: updated, payer, actualInput: actualInputCanonical, actualOutput: actualOutputCanonical };
}

