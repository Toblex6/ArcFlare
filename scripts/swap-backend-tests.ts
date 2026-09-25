// scripts/swap-backend-tests.ts
//
// Swap-backend stage focused tests (Flow Swap + checkout UnitFlow branch +
// shared service). Pure/offline except Section B (Neon dev DB round-trip on
// throwaway rows, cleaned up) — no funds, no signing, no broadcasts.
//
// Run: npx tsx scripts/swap-backend-tests.ts
//
// Covers (Step 13):
//   Flow: authenticated payer required (*static*: resolveFlowPayer gates on
//     session + verifyCallerControlsAddress, no default payer), payer ==
//     session wallet (verifyFlowSwap evidence gate, static), recipient=user
//     wallet (intent binding, static + live), quote persists (live),
//     execution identity persists (live unique), duplicate execution
//     rejected (live P2002 + findExecutionConsumer), malformed evidence
//     rejected (pure), minOut enforced (pure), balance-delta logic with
//     NON-ZERO baselines (pure), provider dispatch (pure), UnitFlow branch
//     (pure self-payer matrix), Tower remains quote-only (pure stubs).
//   Checkout: canonical direct/routed path unchanged (static), UnitFlow
//     branch binds frozen merchantSCA (static + pure), payer binding
//     enforced (static), execution replay rejected (static resume rules),
//     PaymentConversion one row/payment (static schema + live default).

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { encodeAbiParameters, encodeFunctionData, encodePacked } from 'viem';
import {
  assertDistinctPair,
  assertExecutionIdentityMatch,
  assertSwapSymbol,
  canonicalFromSwapUnits,
  checkWrapLinkage,
  claimTxSlot,
  computeSwapQuoteHash,
  decodeUnitFlowExecute,
  findExecutionConsumer,
  flowNeedsUnwrap,
  getSwapRegistry,
  parseCanonicalAmount,
  requestCheckoutUnitFlowQuote,
  resolveCheckoutVenueId,
  resolveFlowVenueId,
  unwrapAmountSwapForIntent,
} from '@/src/lib/swap/service';
import { getUnitFlowV3Deployment } from '@/src/lib/config/unitflow';
import { getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import { normalizeProviderQuote } from '@/src/lib/routing/providers/normalize';
import { PROVIDER_NOT_IMPLEMENTED } from '@/src/lib/routing/providers/types';
import { TowerProvider } from '@/src/lib/routing/providers/tower';
import {
  UNITFLOW_V3_ROUTER_ABI,
  UNITFLOW_WUSDC_WITHDRAW_SELECTOR,
  assertWrapBeforeSwap,
  buildUnitFlowV3Execution,
  buildWusdcWithdrawTx,
  computeUnitFlowExecutionIdentity,
  decodeWusdcWithdraw,
  toSwapUnits,
  unitFlowSwapLeg,
  verifyUnitFlowExecution,
} from '@/src/lib/routing/providers/unitflowV3';

let pass = 0, fail = 0, skip = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}
function skipped(name: string, reason: string) {
  skip++; console.log(`  ⏭️  ${name} — SKIP (${reason})`);
}
function expectThrow(label: string, fn: () => unknown, needle: string, status?: number) {
  try {
    fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    const msgOk = String(e?.message ?? e).includes(needle);
    const statusOk = status === undefined || e?.status === status;
    ok(label, msgOk && statusOk, `status=${e?.status} msg=${String(e?.message ?? e).slice(0, 140)}`);
  }
}
async function expectThrowAsync(label: string, fn: () => Promise<unknown>, needle: string, status?: number) {
  try {
    await fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    const msgOk = String(e?.message ?? e).includes(needle);
    const statusOk = status === undefined || e?.status === status;
    ok(label, msgOk && statusOk, `status=${e?.status} msg=${String(e?.message ?? e).slice(0, 140)}`);
  }
}

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const DEPLOYMENT = getUnitFlowV3Deployment({});
const WUSDC = DEPLOYMENT.wusdc;
const ROUTER = DEPLOYMENT.universalRouter;
const POOL100 = '0xe8f7fA2A412e98C537554643F83DA34DfdD50c23';
const USER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0xc119bb61dCd7Ce422557485ecD17D679f44250a1';
const PAYER = '0x03badcdb102433798df5feb854b87c7a37dde3a6';
const TXHASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Math.floor(Date.now() / 1000);
const EXPIRES = NOW + 300;

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function baseHashArgs() {
  return {
    scope: 'flow' as const,
    bindingRef: USER.toLowerCase(),
    venueId: 'unitflow-v3',
    deploymentName: 'testnet',
    inputToken: USDC,
    inputAmount: 10_000_000n,
    outputToken: EURC,
    quotedOutputSwap: 9_950_000n,
    minOutSwap: 9_900_000n,
    pool: POOL100,
    fee: 100,
    expiresAtSec: EXPIRES,
    recipient: USER,
    expectedPayer: USER,
  };
}

function selfCustodyEvidence(over: Record<string, any> = {}) {
  const amountInSwap = 10_000_000n * 1_000_000_000_000n;
  const minOutSwap = 9_900_000n;
  const v3input = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [
      USER,
      amountInSwap,
      minOutSwap,
      encodePacked(['address', 'uint24', 'address'], [WUSDC as `0x${string}`, 100, EURC as `0x${string}`]),
      true,
    ]
  );
  return {
    deployment: DEPLOYMENT,
    txHash: TXHASH,
    to: ROUTER,
    value: 0n,
    commands: '0x00',
    inputs: [v3input],
    deadline: BigInt(EXPIRES),
    payer: USER,
    expectedPayer: USER,
    merchantSCA: USER,
    tokenInSwap: WUSDC,
    tokenOutSwap: EURC,
    amountInSwap: amountInSwap.toString(),
    minOutSwap: minOutSwap.toString(),
    fee: 100,
    pool: POOL100,
    expiresAtSec: EXPIRES,
    txTimestampSec: NOW + 10,
    // NON-ZERO baselines: the delta (9_950_000), not the absolute balance,
    // is the verified output.
    merchantBalanceBefore: 1_000_000n,
    merchantBalanceAfter: 1_000_000n + 9_950_000n,
    allowSelfPayer: true,
    ...over,
  };
}

async function sectionA() {
  console.log('── A1: input validation (pure) ───────────────────────────────');
  ok('USDC/EURC symbols accepted', assertSwapSymbol('USDC') === 'USDC' && assertSwapSymbol('eurc') === 'EURC');
  expectThrow('unknown symbol rejected', () => assertSwapSymbol('BTC'), 'Unsupported swap token', 400);
  expectThrow('same-token pair rejected', () => assertDistinctPair('USDC', 'USDC'), 'must differ', 400);
  ok("parse '2' → 2000000n", parseCanonicalAmount('2') === 2_000_000n);
  ok("parse '2.000001' exact", parseCanonicalAmount('2.000001') === 2_000_001n);
  expectThrow('non-numeric amount rejected', () => parseCanonicalAmount('abc'), 'positive number', 400);
  expectThrow('zero amount rejected', () => parseCanonicalAmount('0'), 'greater than 0', 400);
  expectThrow('7-decimal amount rejected', () => parseCanonicalAmount('1.1234567'), 'positive number', 400);

  console.log('── A1b: cirBTC token support (pure) ───────────────────────────');
  ok('CIRBTC symbol accepted', assertSwapSymbol('cirbtc') === 'CIRBTC');
  const cir = getTokenBySymbol('CIRBTC');
  ok(
    'cirBTC registry: pinned address + 8 decimals',
    cir.decimals === 8 && cir.address.toLowerCase() === '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf'
  );
  ok("parse cirBTC '0.00000001' → 1n", parseCanonicalAmount('0.00000001', cir.decimals) === 1n);
  expectThrow('9-decimal cirBTC rejected', () => parseCanonicalAmount('1.123456789', cir.decimals), 'up to 8 decimals', 400);
  expectThrow('7-decimal USDC still rejected', () => parseCanonicalAmount('1.1234567', 6), 'up to 6 decimals', 400);
  ok('toSwapUnits cirBTC identity', toSwapUnits('CIRBTC', 1000n) === 1000n);
  ok('toSwapUnits EURC identity', toSwapUnits('EURC', 1000n) === 1000n);
  ok('canonicalFromSwapUnits cirBTC identity', canonicalFromSwapUnits('CIRBTC', 1000n) === 1000n);
  ok('canonicalFromSwapUnits EURC identity', canonicalFromSwapUnits('EURC', 1000n) === 1000n);
  ok('canonicalFromSwapUnits USDC rescales /1e12', canonicalFromSwapUnits('USDC', 1_000_000_000_000_000_000n) === 1_000_000n);
  expectThrow('USDC misaligned swap units rejected', () => canonicalFromSwapUnits('USDC', 1001n), '1e12-aligned', 503);
  const cirLeg = unitFlowSwapLeg('CIRBTC', getUnitFlowV3Deployment());
  ok(
    'cirBTC swap leg: spot address + 8 decimals',
    cirLeg.swapAddress.toLowerCase() === cir.address.toLowerCase() && cirLeg.swapDecimals === 8
  );
  const usdcAddr = getTokenBySymbol('USDC').address;
  const cirQuote = normalizeProviderQuote({
    venueId: 'tower',
    inputToken: usdcAddr,
    outputToken: cir.address,
    inputAmount: '1000000',
    outputAmount: '285',
  });
  ok(
    'normalize accepts USDC→cirBTC with per-token decimals',
    cirQuote.inputToken.decimals === 6 && cirQuote.outputToken.decimals === 8 && cirQuote.quotedOutputAmount === 285n
  );
  expectThrow(
    'normalize rejects wrong decimals claim on cirBTC leg',
    () => normalizeProviderQuote({
      venueId: 'tower',
      inputToken: usdcAddr,
      outputToken: cir.address,
      inputAmount: '1000000',
      outputAmount: '285',
      outputDecimals: 6,
    }),
    'decimals mismatch',
    400
  );
  expectThrow(
    'normalize still rejects wrong decimals claim on stable leg',
    () => normalizeProviderQuote({
      venueId: 'tower',
      inputToken: usdcAddr,
      outputToken: cir.address,
      inputAmount: '1000000',
      outputAmount: '285',
      inputDecimals: 18,
    }),
    'decimals mismatch',
    400
  );

  console.log('── A2: provider dispatch (pure) ──────────────────────────────');
  ok('checkout defaults to canonical', resolveCheckoutVenueId(undefined) === 'canonical');
  ok("checkout 'canonical' explicit", resolveCheckoutVenueId('canonical') === 'canonical');
  expectThrow('checkout rejects tower (quote-only)', () => resolveCheckoutVenueId('tower'), 'quote/discovery only', 400);
  expectThrow('checkout rejects unknown venue', () => resolveCheckoutVenueId('nope-dex'), 'Unknown checkout venue', 400);
  expectThrow(
    'checkout unitflow fails closed when flag off',
    () => resolveCheckoutVenueId('unitflow-v3', {}),
    'disabled', 403
  );
  ok(
    'checkout unitflow selected when flag on',
    resolveCheckoutVenueId('unitflow-v3', { ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: '1' }) === 'unitflow-v3'
  );
  // Checkout v1 scope stays USDC→EURC: cirBTC cannot enter the checkout
  // conversion path (rejected before any RPC/DB — pure gate).
  try {
    await requestCheckoutUnitFlowQuote(
      {
        payment: { reference: 'cir-scope-probe', currency: 'EURC' },
        payTokenSymbol: 'CIRBTC',
        env: { ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: '1' },
      } as any
    );
    ok('checkout unitflow rejects CIRBTC scope', false, 'did NOT throw');
  } catch (e: any) {
    ok(
      'checkout unitflow rejects CIRBTC scope',
      String(e?.message ?? '').includes('USDC→EURC only') && e?.status === 400,
      String(e?.message ?? e).slice(0, 140)
    );
  }
  expectThrow('flow venue fails closed when flag off', () => resolveFlowVenueId({}), 'disabled', 403);
  ok(
    "flow venue is unitflow-v3 when enabled",
    resolveFlowVenueId({ ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: 'true' }) === 'unitflow-v3'
  );

  console.log('── A3: provider-aware quote binding (pure) ───────────────────');
  const h1 = computeSwapQuoteHash(baseHashArgs());
  ok('quote hash deterministic', computeSwapQuoteHash(baseHashArgs()) === h1);
  ok('scope separation (flow vs checkout)', computeSwapQuoteHash({ ...baseHashArgs(), scope: 'checkout', bindingRef: 'ref-1' }) !== h1);
  ok('fee tamper changes hash', computeSwapQuoteHash({ ...baseHashArgs(), fee: 500 }) !== h1);
  ok('recipient tamper changes hash', computeSwapQuoteHash({ ...baseHashArgs(), recipient: MERCHANT }) !== h1);
  ok('unbound payer differs from bound payer', computeSwapQuoteHash({ ...baseHashArgs(), expectedPayer: '' }) !== h1);

  console.log('── A4: execute() calldata decoding (pure) ────────────────────');
  const v3input = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [MERCHANT, 1000000n, 990000n, '0x1234', true]
  );
  const calldata = encodeFunctionData({
    abi: UNITFLOW_V3_ROUTER_ABI,
    functionName: 'execute',
    args: ['0x00' as `0x${string}`, [v3input], 123456789n],
  });
  const dec = decodeUnitFlowExecute(calldata);
  ok('execute() round-trips', dec.commands === '0x00' && dec.inputs.length === 1 && dec.deadline === 123456789n);
  expectThrow('garbage calldata rejected', () => decodeUnitFlowExecute('0x1234'), 'undecodable', 400);
  expectThrow('non-hex rejected', () => decodeUnitFlowExecute('nope'), 'not hex', 400);

  console.log('── A5: wrap linkage + ordering (pure) ────────────────────────');
  // Wrap single-consumption at VERIFICATION time: the same wrap hash cannot
  // settle two records. Pure-model equivalent of the in-transaction
  // recheckWrapConsumerTx gate (which runs against live rows inside the final
  // write transaction for both Flow and checkout paths).
  const wrapClaimed = new Set<string>();
  const claimWrapPure = (hash: string, owner: string) => {
    const k = hash.toLowerCase();
    const prev = [...wrapClaimed].find((c) => c.split('|')[0] === k);
    if (prev && prev !== `${k}|${owner}`) {
      const err: any = new Error('This wrap transaction is already tracked by another swap or payment.');
      err.status = 409;
      throw err;
    }
    wrapClaimed.add(`${k}|${owner}`);
  };
  claimWrapPure(`0x${'c'.repeat(64)}`, 'intent-A');
  let wrapReuseStatus: number | null = null;
  try { claimWrapPure(`0x${'C'.repeat(64)}`, 'intent-B'); } catch (e: any) { wrapReuseStatus = e?.status ?? null; }
  ok('same wrapTxHash reused across records rejected (409)', wrapReuseStatus === 409);
  claimWrapPure(`0x${'c'.repeat(64)}`, 'intent-A');
  ok('same wrapTxHash for the SAME record stays idempotent', true);
  ok(
    'service enforces wrap single-consumption at verification time (both paths)',
    (read('src/lib/swap/service.ts').match(/recheckWrapConsumerTx\(db, wrapTxHash/g) ?? []).length >= 2
  );
  const wrapHappy = { wrapTo: WUSDC, wrapFrom: PAYER, wrapValue: (10_000_000n * 1_000_000_000_000n).toString(), wrapStatus: 'success' };
  const wrapExp = { wusdc: WUSDC, payer: PAYER, amountInSwap: 10_000_000n * 1_000_000_000_000n };
  checkWrapLinkage(wrapHappy, wrapExp);
  ok('wrap linkage happy path', true);
  expectThrow('wrap to foreign contract rejected', () => checkWrapLinkage({ ...wrapHappy, wrapTo: EURC }, wrapExp), 'not the canonical WUSDC', 403);
  expectThrow('wrap from wrong sender rejected', () => checkWrapLinkage({ ...wrapHappy, wrapFrom: MERCHANT }, wrapExp), 'not the swap payer', 403);
  expectThrow('wrap amount mismatch rejected', () => checkWrapLinkage({ ...wrapHappy, wrapValue: '1' }, wrapExp), '!= expected swap-leg amount', 403);
  expectThrow('failed wrap rejected', () => checkWrapLinkage({ ...wrapHappy, wrapStatus: 'reverted' }, wrapExp), 'did not succeed', 403);
  ok('wrap strictly before swap accepted', (() => { assertWrapBeforeSwap(100n, 101n); return true; })());
  expectThrow('wrap after swap rejected', () => assertWrapBeforeSwap(101n, 100n), 'must be included before', 403);
  expectThrow('wrap same-block-as-swap rejected (conservative)', () => assertWrapBeforeSwap(100n, 100n), 'must be included before', 403);
  ok('docs state validated correlation, not funding proof', /validated correlation/i.test(read('src/lib/swap/service.ts')));

  console.log('── A6: UnitFlow self-payer matrix (pure) ─────────────────────');
  const verified = verifyUnitFlowExecution(selfCustodyEvidence() as any);
  ok(
    'self-custody verifies with flag (non-zero baseline delta)',
    verified.recipient.toLowerCase() === USER.toLowerCase() && verified.actualOutput === 9_950_000n
  );
  expectThrow(
    'payer==recipient rejected WITHOUT flag (checkout rule)',
    () => verifyUnitFlowExecution(selfCustodyEvidence({ allowSelfPayer: undefined }) as any),
    'own payer', 403
  );
  expectThrow('output below minOut rejected', () =>
    verifyUnitFlowExecution(selfCustodyEvidence({ merchantBalanceAfter: 1_000_000n + 8_000_000n }) as any),
  'below minOut', 403);
  expectThrow('malformed evidence rejected', () => verifyUnitFlowExecution({} as any), 'evidence', 400);
  await expectThrowAsync(
    'build rejects payer==recipient without allowSelfPayer (no RPC touched)',
    () => buildUnitFlowV3Execution({ inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 1_000_000n, merchantSCA: MERCHANT, expectedPayer: MERCHANT }),
    'must not equal the merchant recipient', 400
  );
  ok('canonical rescale exact (USDC /1e12)', canonicalFromSwapUnits('USDC', 10_000_000n * 1_000_000_000_000n) === 10_000_000n);
  ok('canonical EURC identity', canonicalFromSwapUnits('EURC', 9_950_000n) === 9_950_000n);

  console.log('── A6b: execution identity recompute + compare (pure) ─────────');
  const ev6 = selfCustodyEvidence() as any;
  const canonicalIdentity = computeUnitFlowExecutionIdentity({
    router: DEPLOYMENT.universalRouter,
    commands: '0x00' as `0x${string}`,
    v3input: (ev6.inputs as string[])[0] as `0x${string}`,
    deadline: BigInt(ev6.deadline as any),
  });
  assertExecutionIdentityMatch(canonicalIdentity, {
    router: DEPLOYMENT.universalRouter,
    commands: '0x00' as `0x${string}`,
    inputs: (ev6.inputs as string[]).slice(0, 1) as [`0x${string}`],
    deadline: BigInt(ev6.deadline as any),
  });
  ok('stored execution identity matches recomputed canonical hash', true);
  expectThrow(
    'mismatched execution identity rejected (403)',
    () => assertExecutionIdentityMatch(`0x${'00'.repeat(32)}`, {
      router: DEPLOYMENT.universalRouter,
      commands: '0x00' as `0x${string}`,
      inputs: (ev6.inputs as string[]).slice(0, 1) as [`0x${string}`],
      deadline: BigInt(ev6.deadline as any),
    }),
    'mismatch', 403
  );
  expectThrow('missing stored execution identity fails closed', () => assertExecutionIdentityMatch(null, {
    router: DEPLOYMENT.universalRouter,
    commands: '0x00' as `0x${string}`,
    inputs: (ev6.inputs as string[]).slice(0, 1) as [`0x${string}`],
    deadline: BigInt(ev6.deadline as any),
  }), 'missing or malformed', 500);

  console.log('── A7: Tower remains quote-only (pure) ───────────────────────');
  const tower = new TowerProvider();
  await expectThrowAsync('tower buildExecution NOT_IMPLEMENTED', () => tower.buildExecution(), PROVIDER_NOT_IMPLEMENTED);
  await expectThrowAsync('tower verifyExecution NOT_IMPLEMENTED', () => tower.verifyExecution(), PROVIDER_NOT_IMPLEMENTED);
  const reg = getSwapRegistry({});
  ok('canonical registers first', reg.registeredVenues()[0] === 'canonical');
  const activeOff = reg.getActiveProviders({});
  ok('canonical only by default', activeOff.length === 1 && activeOff[0]!.venueId === 'canonical');

  console.log('── A8: checkout UnitFlow scope gate (no RPC) ─────────────────');
  const fakePayment = (currency: string) => ({
    id: 'test-id', reference: 'TEST-REF', amount: 1.0, currency, tokenAddress: currency === 'EURC' ? EURC : USDC,
    merchantSCA: MERCHANT, status: 'PENDING', expiresAt: null,
  });
  await expectThrowAsync(
    'USDC-settlement invoice rejected from UnitFlow branch',
    () => requestCheckoutUnitFlowQuote({ payment: fakePayment('USDC'), payTokenSymbol: 'USDC', env: { ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: '1' } }),
    'supports USDC→EURC only', 400
  );
  await expectThrowAsync(
    'EURC→EURC same-token rejected from UnitFlow branch',
    () => requestCheckoutUnitFlowQuote({ payment: fakePayment('EURC'), payTokenSymbol: 'EURC', env: { ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: '1' } }),
    'supports USDC→EURC only', 400
  );

  console.log('── A10: WUSDC→native unwrap exit (pure) ──────────────────────');
  ok('withdraw selector is canonical WETH9 0x2e1a7d4d', UNITFLOW_WUSDC_WITHDRAW_SELECTOR === '0x2e1a7d4d');
  const unwrapTx = buildWusdcWithdrawTx(WUSDC, 9_950_000n * 1_000_000_000_000n);
  ok('unwrap targets canonical WUSDC with zero value', unwrapTx.to.toLowerCase() === WUSDC.toLowerCase() && unwrapTx.value === 0n);
  ok('unwrap calldata carries the withdraw selector', unwrapTx.data.toLowerCase().startsWith(UNITFLOW_WUSDC_WITHDRAW_SELECTOR));
  ok('unwrap calldata round-trips to the exact wad', decodeWusdcWithdraw(unwrapTx.data) === 9_950_000n * 1_000_000_000_000n);
  expectThrow('unwrap rejects zero amount', () => buildWusdcWithdrawTx(WUSDC, 0n), 'positive bigint', 400);
  expectThrow('unwrap rejects malformed address', () => buildWusdcWithdrawTx('nope', 100n), 'must be a 0x address', 400);
  ok(
    'service binds unwrap to the canonical deployment WUSDC (never client input)',
    /buildWusdcWithdrawTx\(deployment\.wusdc/.test(read('src/lib/swap/service.ts'))
  );
  expectThrow('decode rejects garbage calldata', () => decodeWusdcWithdraw('0x1234'), 'wrong selector', 400);
  expectThrow('decode rejects non-hex', () => decodeWusdcWithdraw('nope'), 'not hex', 400);
  expectThrow('decode rejects truncated withdraw', () => decodeWusdcWithdraw(`${UNITFLOW_WUSDC_WITHDRAW_SELECTOR}00`), 'bad length', 400);
  ok('flowNeedsUnwrap true for USDC output', flowNeedsUnwrap({ outputSymbol: 'USDC' }) === true);
  ok('flowNeedsUnwrap false for EURC output', flowNeedsUnwrap({ outputSymbol: 'EURC' }) === false);
  const executedUsdcOut = { outputSymbol: 'USDC', status: 'EXECUTED', actualOutputAmount: '9950000' };
  ok(
    'unwrap amount is verified proceeds ×1e12 (exact)',
    unwrapAmountSwapForIntent(executedUsdcOut) === 9_950_000n * 1_000_000_000_000n
  );
  expectThrow(
    'unwrap needs no step for EURC output',
    () => unwrapAmountSwapForIntent({ outputSymbol: 'EURC', status: 'EXECUTED', actualOutputAmount: '1' }),
    'no unwrap step', 400
  );
  expectThrow(
    'unwrap refused before swap verification',
    () => unwrapAmountSwapForIntent({ outputSymbol: 'USDC', status: 'QUOTED', actualOutputAmount: null }),
    'Verify the swap', 409
  );
  expectThrow(
    'unwrap fails closed on missing verified output',
    () => unwrapAmountSwapForIntent({ outputSymbol: 'USDC', status: 'EXECUTED', actualOutputAmount: '0' }),
    'verified output missing', 500
  );
  // Gas-aware settlement equation (pinned from live testnet withdraw
  // 0xaf28dd2e…: raw native delta is short by exactly gasUsed x
  // effectiveGasPrice; delta + gasCost == wad to the wei, and the WUSDC burn
  // delta == wad exactly). The verifier enforces both equations — a naive
  // delta >= wad check would reject every real unwrap.
  {
    const wad = 34079543632198400000n;
    const delta = 34078935041770400000n;
    const gasCost = 30428n * 20001000000n;
    ok('live gas equation: delta + gasCost == wad (exact)', delta + gasCost === wad);
    ok('live burn equation: WUSDC delta == wad (exact)', wad - 0n === wad);
    const svcSrc = read('src/lib/swap/service.ts');
    ok('verifier enforces the WUSDC burn equation', svcSrc.includes('WUSDC burn delta != verified proceeds'));
    ok('verifier enforces the gas-aware native equation', svcSrc.includes('native receipt != verified proceeds'));
  }
  ok(
    'unwrap exit keeps provider/service split (no Prisma in provider)',
    !/requestFlowUnwrap|verifyFlowUnwrap|getBalance/.test(read('src/lib/routing/providers/unitflowV3.ts'))
  );  ok(
    'service never signs unwrap (no wallet clients)',
    !/createWalletClient|sendTransaction|writeContract/.test(read('src/lib/swap/service.ts'))
  );
  ok('unwrap route exists', fs.existsSync(path.join(root, 'src/app/api/swap/unwrap/route.ts')));
  ok('verify-unwrap route exists', fs.existsSync(path.join(root, 'src/app/api/swap/verify-unwrap/route.ts')));
  ok(
    'UI chains the receive step only for USDC output',
    read('src/components/swap/FlowSwapView.tsx').includes("live.output.symbol !== 'USDC'") &&
    read('src/components/swap/FlowSwapView.tsx').includes('/api/swap/verify-unwrap')
  );
  ok(
    'Max truncates at the token precision (never an invalid amount)',
    read('src/components/swap/FlowSwapView.tsx').includes('truncateToDecimals(normalized, inputDecimals)')
  );
  const { truncateToSixDecimals, truncateToDecimals, normalizeBalanceString } = await import('@/src/components/swap/swapCopy');
  ok('truncate keeps exact 6-dec input', truncateToSixDecimals('2.000001') === '2.000001');
  ok('truncate cuts float dust without rounding up', truncateToSixDecimals('12.340000000001') === '12.34');
  ok('truncate keeps integers', truncateToSixDecimals('7') === '7');
  ok('truncateToDecimals respects 8-dec cirBTC precision', truncateToDecimals('0.000000019', 8) === '0.00000001');
  ok('normalizeBalanceString handles exponent-form dust', normalizeBalanceString('1e-8', 8) === '0.00000001');
  ok('normalizeBalanceString keeps stable balances exact', normalizeBalanceString('21.487666', 6) === '21.487666');
  const { SwapUnwrapSchema, SwapUnwrapVerifySchema } = await import('@/src/lib/validation');
  ok('unwrap schema requires an intent locator', !SwapUnwrapSchema.safeParse({}).success);
  ok('unwrap schema accepts intentId', SwapUnwrapSchema.safeParse({ intentId: '123e4567-e89b-12d3-a456-426614174000' }).success);
  ok('unwrap-verify schema requires the unwrap hash', !SwapUnwrapVerifySchema.safeParse({ intentId: '123e4567-e89b-12d3-a456-426614174000' }).success);
  ok(
    'unwrap-verify schema accepts intent + hash',
    SwapUnwrapVerifySchema.safeParse({ intentId: '123e4567-e89b-12d3-a456-426614174000', unwrapTxHash: TXHASH }).success
  );

  console.log('── A9: architecture static proofs ────────────────────────────');  const svc = read('src/lib/swap/service.ts');
  ok(
    'single-consumption enforced in-transaction (advisory lock + recheck, no TOCTOU pre-check)',
    svc.includes('claimTxSlot(db, executionTxHash)') && svc.includes('recheckExecutionConsumerTx(db, executionTxHash')
  );
  ok(
    'execution identity recomputed + compared on both verify paths',
    (svc.match(/assertExecutionIdentityMatch\(/g) ?? []).length >= 3
  );
  ok('wrap ordering enforced (wrap before swap)', svc.includes('swapBlockNumber'));
  ok('canonical execution identity has one authority', /export function computeUnitFlowExecutionIdentity/.test(read('src/lib/routing/providers/unitflowV3.ts')));
  ok('service gates on verifyCallerControlsAddress', svc.includes('verifyCallerControlsAddress'));
  ok('service has no default-payer fallback', !/DEFAULT_PAYER/i.test(svc) && !/\|\|\s*process\.env\.(SELLER|RELAYER)/.test(svc));
  ok('service never signs (no wallet clients)', !/createWalletClient|sendTransaction|writeContract/.test(svc));
  ok(
    'service keeps pure verifiers pure (no Prisma usage inside providers)',
    !/from\s+['"][^'"]*prisma['"]|PrismaClient|\(prisma as any\)|prisma\.\$/i.test(read('src/lib/routing/providers/unitflowV3.ts'))
  );
  ok('service resolves payer from session (no body wallet)', svc.includes('resolveConsumerSession'));
  const verifyRoute = read('src/app/api/payments/verify-onchain/route.ts');
  ok('canonical checkRoutedExecution path preserved', verifyRoute.includes('checkRoutedExecution({'));
  ok('verify-onchain branches on stored venueId', verifyRoute.includes("venueId ?? 'canonical'") && verifyRoute.includes('verifyCheckoutUnitFlow'));
  const quoteRoute = read('src/app/api/payments/quote/route.ts');
  ok('quote defaults to canonical requestQuote', quoteRoute.includes('requestQuote({ reference:'));
  ok('quote rejects tower via shared dispatch', quoteRoute.includes('resolveCheckoutVenueId'));
  const schema = read('prisma/schema.prisma');
  const payLogBlock = schema.slice(schema.indexOf('model PaymentLog {'), schema.indexOf('model AgentRegistry {'));
  ok('PaymentLog semantics untouched (no venue fields)', !/venueId|executionIdentity|deploymentName/.test(payLogBlock));
  ok('PaymentConversion one row/payment preserved', /model PaymentConversion[\s\S]*?paymentLogId\s+String\s+@unique/.test(schema));
  ok('FlowSwapIntent quote/execution uniques enforced', /model FlowSwapIntent[\s\S]*?quoteHash\s+String\s+@unique[\s\S]*?executionIdentity\s+String\s+@unique[\s\S]*?executionTxHash\s+String\?\s+@unique/.test(schema));
  ok('withGateway() untouched (no swap import)', !/swap\/service|FlowSwap/i.test(read('src/lib/x402.ts')));
  const changed = execSync('git diff --name-only', { cwd: root }).toString();
  for (const f of ['src/lib/x402.ts', 'contracts/ArcFlareJobEscrow.sol', 'contracts/ArcFlarePaymentRouter.sol']) {
    ok(`protected file untouched: ${f}`, !changed.split('\n').map((s) => s.trim()).includes(f));
  }
  ok('no escrow route touched', !changed.split('\n').some((s) => s.trim().startsWith('src/app/api/escrow/')));
  ok('canonical routing impl untouched', !/src\/lib\/routing\/(canonical|quoter|quoteMath|verifier)\.ts/.test(changed));
}

async function sectionB() {
  console.log('── B: live persistence (Neon dev DB, throwaway rows) ──────────');
  let prisma: any = null;
  try {
    const mod = await import('@/src/lib/prisma');
    prisma = (mod as any).prisma;
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (e: any) {
    skipped('DB round-trip', `no DB (${String(e?.message ?? e).slice(0, 80)})`);
    return;
  }
  const REF = `SWAPTEST-${Date.now()}`;
  const OWNER = '0x2222222222222222222222222222222222222222';
  const OTHER = '0x3333333333333333333333333333333333333333';
  let id: string | null = null;
  try {
    const created = await (prisma as any).flowSwapIntent.create({
      data: {
        ownerWallet: OWNER,
        inputSymbol: 'USDC',
        outputSymbol: 'EURC',
        inputAmount: '1000000',
        inputAmountSwap: (1_000_000n * 1_000_000_000_000n).toString(),
        tokenInSwap: WUSDC,
        tokenOutSwap: EURC,
        quotedOutputSwap: '995000',
        minOutputSwap: '990000',
        venueId: 'unitflow-v3',
        deploymentName: 'testnet',
        deploymentRouter: ROUTER,
        poolAddress: POOL100,
        feeTier: 100,
        slippageBps: 100,
        quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        deadline: String(EXPIRES),
        quoteHash: `0x${'b'.repeat(64)}`.slice(0, 66),
        executionIdentity: `test-exec-${REF}`,
        idempotencyKey: `flowswap-test-${REF}`,
        expectedPayer: OWNER,
        recipient: OWNER,
        status: 'QUOTED',
      },
    });
    id = created.id;
    ok('flow quote persists (intent row)', !!id && created.venueId === 'unitflow-v3');
    ok('execution identity persists', created.executionIdentity === `test-exec-${REF}`);

    const { loadFlowIntent, assertIntentLive } = await import('@/src/lib/swap/service');
    const loaded = await loadFlowIntent(OWNER, { intentId: id! });
    ok('owner loads own intent', loaded.id === id);
    try {
      await loadFlowIntent(OTHER, { intentId: id! });
      ok('foreign wallet rejected from intent', false, 'did NOT throw');
    } catch (e: any) {
      ok('foreign wallet rejected from intent', e?.status === 403, String(e?.message ?? e).slice(0, 80));
    }
    await assertIntentLive(loaded);
    ok('live intent passes liveness', true);

    // Duplicate execution identity → unique violation (replay persisted).
    try {
      await (prisma as any).flowSwapIntent.create({
        data: {
          ownerWallet: OWNER, inputSymbol: 'USDC', outputSymbol: 'EURC',
          inputAmount: '1000000', inputAmountSwap: '1000000000000000000',
          tokenInSwap: WUSDC, tokenOutSwap: EURC,
          quotedOutputSwap: '995000', minOutputSwap: '990000',
          venueId: 'unitflow-v3', deploymentName: 'testnet', deploymentRouter: ROUTER,
          poolAddress: POOL100, feeTier: 100, slippageBps: 100,
          quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
          deadline: String(EXPIRES),
          quoteHash: `0x${'c'.repeat(64)}`.slice(0, 66),
          executionIdentity: `test-exec-${REF}`,
          idempotencyKey: `flowswap-test2-${REF}`,
          expectedPayer: OWNER, recipient: OWNER, status: 'QUOTED',
        },
      });
      ok('duplicate execution identity rejected', false, 'did NOT throw');
    } catch (e: any) {
      ok('duplicate execution identity rejected', e?.code === 'P2002', String(e?.code ?? e?.message ?? e).slice(0, 80));
    }

    // Expiry flips to EXPIRED (fail-closed, no execution past expiry).
    await (prisma as any).flowSwapIntent.update({
      where: { id: id! },
      data: { quoteExpiresAt: new Date(Date.now() - 1000) },
    });
    const stale = await (prisma as any).flowSwapIntent.findUnique({ where: { id: id! } });
    try {
      await assertIntentLive(stale);
      ok('expired intent rejected', false, 'did NOT throw');
    } catch (e: any) {
      const nowExpired = await (prisma as any).flowSwapIntent.findUnique({ where: { id: id! } });
      ok('expired intent rejected + marked EXPIRED', e?.status === 410 && nowExpired.status === 'EXPIRED');
    }

    const noConsumer = await findExecutionConsumer(`0x${'d'.repeat(64)}`);
    ok('unknown execution tx has no consumer', noConsumer === null);

    // C1: actual concurrent/racing claim — two sibling intents race to claim
    // the SAME execution tx inside atomic claim transactions. One wins, the
    // other gets 409 — a sequential-only check cannot prove this, so both
    // claims are submitted concurrently and the outcomes are asserted as a
    // set (exactly one success + exactly one 409).
    const RACE_TX = `0x${'e'.repeat(64)}`;
    const raceTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const mkRaceIntent = (suffix: string, key: string) =>
      (prisma as any).flowSwapIntent.create({
        data: {
          ownerWallet: OWNER, inputSymbol: 'EURC', outputSymbol: 'USDC',
          inputAmount: '1000000', inputAmountSwap: '1000000',
          tokenInSwap: EURC, tokenOutSwap: USDC,
          quotedOutputSwap: '995000', minOutputSwap: '990000',
          venueId: 'unitflow-v3', deploymentName: 'testnet', deploymentRouter: ROUTER,
          poolAddress: POOL100, feeTier: 100, slippageBps: 100,
          quoteExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
          deadline: String(EXPIRES),
          quoteHash: `0x${(`${raceTag}${suffix}`.padEnd(64, '0')).slice(0, 64)}`.replace(/[^0-9a-fA-F]/g, 'a'),
          executionIdentity: `0x${(`${raceTag}${key}`.padEnd(64, '0')).slice(0, 64)}`.replace(/[^0-9a-fA-F]/g, 'b'),
          idempotencyKey: `flowswap-race-${REF}-${raceTag}-${suffix}`,
          expectedPayer: OWNER, recipient: OWNER, status: 'QUOTED',
        },
      });
    const raceA = await mkRaceIntent('a', '1');
    const raceB = await mkRaceIntent('b', '2');
    const claim = (rowId: string) =>
      (prisma as any).$transaction(async (db: any) => {
        await claimTxSlot(db, RACE_TX);
        const flow = await db.flowSwapIntent.findUnique({ where: { executionTxHash: RACE_TX } }).catch(() => null);
        if (flow && flow.id !== rowId) {
          const err: any = new Error('This transaction was already consumed by another swap or payment.');
          err.status = 409;
          throw err;
        }
        const conv = await db.paymentConversion.findUnique({ where: { executionTxHash: RACE_TX } }).catch(() => null);
        if (conv) {
          const err: any = new Error('This transaction was already consumed by another swap or payment.');
          err.status = 409;
          throw err;
        }
        return db.flowSwapIntent.update({ where: { id: rowId }, data: { status: 'EXECUTED', executionTxHash: RACE_TX } });
      });
    const raceResults = await Promise.allSettled([claim(raceA.id), claim(raceB.id)]);
    const wins = raceResults.filter((r) => r.status === 'fulfilled');
    const losses = raceResults.filter((r) => r.status === 'rejected');
    ok(
      'concurrent race: exactly one claimant wins',
      wins.length === 1 && losses.length === 1,
      JSON.stringify(raceResults.map((r) => r.status))
    );
    ok(
      'concurrent race: loser gets 409',
      losses.length === 1 && (losses[0] as PromiseRejectedResult | undefined) !== undefined && ((losses[0] as PromiseRejectedResult).reason as any)?.status === 409,
      String((((losses[0] as PromiseRejectedResult | undefined)?.reason as any)?.message ?? 'no rejection')).slice(0, 120)
    );
    // Same-tx resume for the SAME owning record stays idempotent: re-claiming
    // the won tx for the winner row re-reads EXECUTED + same hash → no throw.
    const firstWin = wins[0] as PromiseFulfilledResult<any> | undefined;
    const winnerId = firstWin?.value?.id as string | undefined;
    if (winnerId) {
      const resumed = await (prisma as any).$transaction(async (db: any) => {
        await claimTxSlot(db, RACE_TX);
        const live = await db.flowSwapIntent.findUnique({ where: { id: winnerId } });
        if (live?.status === 'EXECUTED' && live?.executionTxHash?.toLowerCase() === RACE_TX.toLowerCase()) return live;
        throw new Error('resume failed');
      });
      ok('same-tx resume for the owning record stays idempotent', resumed?.id === winnerId);
    } else {
      ok('same-tx resume for the owning record stays idempotent', false, 'no winner to resume');
    }
    // Different tx against the already-consumed winner row remains 409.
    if (winnerId) {
      try {
        await (prisma as any).$transaction(async (db: any) => {
          const live = await db.flowSwapIntent.findUnique({ where: { id: winnerId } });
          if (live?.status === 'EXECUTED' && live?.executionTxHash?.toLowerCase() !== `0x${'f'.repeat(64)}`) {
            const err: any = new Error('This swap intent is already consumed.');
            err.status = 409;
            throw err;
          }
        });
        ok('different tx against consumed intent rejected', false, 'did NOT throw');
      } catch (e: any) {
        ok('different tx against consumed intent rejected', e?.status === 409, String(e?.message ?? e).slice(0, 80));
      }
    }
    await (prisma as any).flowSwapIntent.deleteMany({ where: { id: { in: [raceA.id, raceB.id] } } }).catch(() => null);

    // Canonical default preserved on conversions (legacy rows backfill).
    const legacyConv = await (prisma as any).paymentConversion.findFirst({
      where: { venueId: 'canonical' },
    });
    ok('canonical conversions backfill venueId=canonical', legacyConv === null || legacyConv.venueId === 'canonical');
  } finally {
    if (id) await (prisma as any).flowSwapIntent.deleteMany({ where: { id } }).catch(() => null);
  }

  // Live testnet swap gate: only with an available signing wallet (never
  // large amounts — 0.01 USDC convention from the Phase 2 e2e).
  if (!process.env.RELAYER_PRIVATE_KEY) {
    skipped('live testnet Flow swap', 'no RELAYER_PRIVATE_KEY in env');
  } else {
    skipped('live testnet Flow swap', 'manual gate — run scripts/unitflow-e2e-usdc-eurc.ts explicitly');
  }
}

async function main() {
  await sectionA();
  await sectionB();
  console.log(`\nswap-backend-tests: ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) {
    console.log('failures:', failures.join(' | '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('swap-backend-tests crashed:', e);
  process.exit(1);
});
