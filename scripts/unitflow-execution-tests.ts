// scripts/unitflow-execution-tests.ts
//
// UnitFlow Phase 2 verifier tests — PURE mocked tests, no live funds, no RPC,
// no DB, no network. Run:
//   npx tsx scripts/unitflow-execution-tests.ts
//
// Covers the Phase 2 negative test matrix for verifyUnitFlowExecution() plus
// the happy-path decoding, the atomic deployment config (Task A), and the
// fail-closed buildExecution() argument validation (no RPC touched — every
// build case throws before any network read).

import { encodeAbiParameters, encodePacked } from 'viem';
import {
  assertUnitFlowDeploymentComplete,
  getUnitFlowV3Deployment,
} from '@/src/lib/config/unitflow';
import {
  buildUnitFlowV3Execution,
  UNITFLOW_V3_ALLOWED_FEES,
  UNITFLOW_V3_DEFAULT_FEE,
  verifyUnitFlowExecution,
  type UnitFlowExecutionEvidence,
} from '@/src/lib/routing/providers/unitflowV3';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
function expectThrow(label: string, fn: () => unknown, needle: string) {
  try {
    fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    ok(label, String(e?.message ?? e).includes(needle), String(e?.message ?? e).slice(0, 160));
  }
}

// ─── Fixtures (mocked, deterministic) ────────────────────────────────────────
const DEPLOYMENT = getUnitFlowV3Deployment({});
const WUSDC = DEPLOYMENT.wusdc;
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ROUTER = DEPLOYMENT.universalRouter;
const PAYER = '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44';
const MERCHANT = '0xc119bb61dCd7Ce422557485ecD17D679f44250a1';
const POOL100 = '0xe8f7fA2A412e98C537554643F83DA34DfdD50c23';
// Known-dead alternate README deployment family (never referenced by the
// canonical config — any evidence carrying these must fail as foreign).
// (Same length as the canonical addresses: 4-char prefix swapped, body kept.)
const DEAD_ROUTER = '0x09ea195bE51861632cd32850973C9515DA48e76F';
const DEAD_FACTORY = '0xb0bC8AAb7d490007634ef59d424b5d89688a1971';
const DEAD_POOL = '0xdeaDfA2A412e98C537554643F83DA34DfdD50c23'; // stands in for a pool derived from the dead Factory 0xb0bC…
const TXHASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Math.floor(Date.now() / 1000);
const EXPIRES = NOW + 300;

const AMOUNT_IN_SWAP = 10_000n * 1_000_000_000_000n; // 0.01 USDC canonical -> 1e16 WUSDC units
const MIN_OUT_SWAP = 6957n; // mocked persisted floor (EURC 6-dec units)

function encodeV3Input(recipient: string, amountIn: bigint, minOut: bigint, path: string): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [recipient as `0x${string}`, amountIn, minOut, path as `0x${string}`, true]
  );
}

function pathFor(tokenIn: string, fee: number, tokenOut: string): `0x${string}` {
  return encodePacked(
    ['address', 'uint24', 'address'],
    [tokenIn as `0x${string}`, fee, tokenOut as `0x${string}`]
  );
}

function happyEvidence(): UnitFlowExecutionEvidence {
  return {
    deployment: DEPLOYMENT,
    txHash: TXHASH,
    to: ROUTER,
    value: 0n,
    commands: '0x00',
    inputs: [encodeV3Input(MERCHANT, AMOUNT_IN_SWAP, MIN_OUT_SWAP, pathFor(WUSDC, 100, EURC))],
    deadline: BigInt(EXPIRES),
    payer: PAYER,
    expectedPayer: PAYER,
    merchantSCA: MERCHANT,
    tokenInSwap: WUSDC,
    tokenOutSwap: EURC,
    amountInSwap: AMOUNT_IN_SWAP,
    minOutSwap: MIN_OUT_SWAP,
    fee: 100,
    pool: POOL100,
    expiresAtSec: EXPIRES,
    txTimestampSec: NOW + 60,
    merchantBalanceBefore: 0n,
    merchantBalanceAfter: MIN_OUT_SWAP + 100n,
  };
}

function withEv(patch: Partial<UnitFlowExecutionEvidence>): UnitFlowExecutionEvidence {
  return { ...happyEvidence(), ...patch };
}

function reencode(patch: { recipient?: string; amountIn?: bigint; minOut?: bigint; path?: string }) {
  const base = happyEvidence();
  const decoded = { recipient: MERCHANT, amountIn: AMOUNT_IN_SWAP, minOut: MIN_OUT_SWAP, path: pathFor(WUSDC, 100, EURC) };
  const next = { ...decoded, ...patch };
  return encodeV3Input(next.recipient, next.amountIn, next.minOut, next.path);
}

async function main() {
  console.log('── deployment config (Task A: atomic, network-aware, fail-closed) ──');
  ok('testnet family matches verified deployment',
    DEPLOYMENT.factory === '0xAb6A8AAb7d490007634ef59d424b5d89688a1971' &&
    DEPLOYMENT.quoter === '0x121aeB6DEf00F6F67665008CaC1C19805886ed1a' &&
    DEPLOYMENT.universalRouter === '0xEaF3195bE51861632cd32850973C9515DA48e76F' &&
    DEPLOYMENT.permit2 === '0x4ce562F687d0Ced27b79Ba51d79B63BD978F7F48' &&
    DEPLOYMENT.wusdc === '0x911b4000D3422F482F4062a913885f7b035382Df' &&
    DEPLOYMENT.chainId === 5042002);
  ok('default fee tier is 100 and allowed set covers docs tiers',
    UNITFLOW_V3_DEFAULT_FEE === 100 &&
    JSON.stringify([...UNITFLOW_V3_ALLOWED_FEES]) === JSON.stringify([100, 500, 3000, 10000]));
  try { assertUnitFlowDeploymentComplete(DEPLOYMENT); ok('complete deployment asserts clean', true); }
  catch (e: any) { ok('complete deployment asserts clean', false, String(e?.message ?? e)); }
  expectThrow('incomplete deployment rejected', () => assertUnitFlowDeploymentComplete({ ...DEPLOYMENT, quoter: '' } as any), 'missing or malformed');
  expectThrow('mainnet without env fails closed', () => getUnitFlowV3Deployment({ ARC_NETWORK: 'mainnet' }), 'missing');
  const mm = getUnitFlowV3Deployment({
    ARC_NETWORK: 'mainnet',
    UNITFLOW_MAINNET_FACTORY: '0x1111111111111111111111111111111111111111',
    UNITFLOW_MAINNET_QUOTER: '0x2222222222222222222222222222222222222222',
    UNITFLOW_MAINNET_UNIVERSAL_ROUTER: '0x3333333333333333333333333333333333333333',
    UNITFLOW_MAINNET_PERMIT2: '0x4444444444444444444444444444444444444444',
    UNITFLOW_MAINNET_WUSDC: '0x5555555555555555555555555555555555555555',
  });
  ok('mainnet resolves explicit env family (no testnet inheritance)',
    mm.factory === '0x1111111111111111111111111111111111111111' && mm.name === 'mainnet');

  console.log('── happy path ───────────────────────────────────────────────────');
  const v = verifyUnitFlowExecution(happyEvidence());
  ok('happy path verifies', v.executionTxHash === TXHASH && v.actualOutput === MIN_OUT_SWAP + 100n &&
    v.fee === 100 && v.pool === POOL100 && v.recipient === MERCHANT && v.payer === PAYER);
  // Non-zero merchant baseline still verifies via DELTA (no zero assumption).
  const nz = verifyUnitFlowExecution(withEv({ merchantBalanceBefore: 5_000n, merchantBalanceAfter: 5_000n + MIN_OUT_SWAP }));
  ok('non-zero merchant baseline verifies via delta', nz.actualOutput === MIN_OUT_SWAP);

  console.log('── negative matrix (21) ─────────────────────────────────────────');
  // 1. wrong merchant recipient
  expectThrow('01 wrong merchant recipient rejected',
    () => verifyUnitFlowExecution(withEv({ inputs: [reencode({ recipient: PAYER })] })), 'wrong merchant recipient');
  // 2. wrong input token
  expectThrow('02 wrong input token rejected',
    () => verifyUnitFlowExecution(withEv({
      inputs: [reencode({ path: pathFor('0x1111111111111111111111111111111111111111', 100, EURC) })],
    })), 'wrong input token');
  // 3. wrong input amount
  expectThrow('03 wrong input amount rejected',
    () => verifyUnitFlowExecution(withEv({ inputs: [reencode({ amountIn: AMOUNT_IN_SWAP + 1n })] })), 'wrong input amount');
  // 4. wrong output token
  expectThrow('04 wrong output token rejected',
    () => verifyUnitFlowExecution(withEv({
      inputs: [reencode({ path: pathFor(WUSDC, 100, '0x2222222222222222222222222222222222222222') })],
    })), 'wrong output token');
  // 5. output below minOut
  expectThrow('05 output below minOut rejected',
    () => verifyUnitFlowExecution(withEv({ merchantBalanceAfter: MIN_OUT_SWAP - 1n })), 'output below minOut');
  // 6. wrong fee tier (separately supplied fee != path fee)
  expectThrow('06 wrong fee tier rejected',
    () => verifyUnitFlowExecution(withEv({ fee: 500 })), 'wrong fee tier');
  // 7. wrong/invalid pool
  expectThrow('07 invalid pool rejected',
    () => verifyUnitFlowExecution(withEv({ pool: '0x0000000000000000000000000000000000000000' })), 'wrong/invalid pool');
  // 8. expired quote
  expectThrow('08 expired quote rejected',
    () => verifyUnitFlowExecution(withEv({ txTimestampSec: EXPIRES + 1 })), 'expired quote');
  // 9. foreign UniversalRouter
  expectThrow('09 foreign UniversalRouter rejected',
    () => verifyUnitFlowExecution(withEv({ to: '0x9999999999999999999999999999999999999999' })), 'foreign UniversalRouter');
  // 10. payer mismatch
  expectThrow('10 payer mismatch rejected',
    () => verifyUnitFlowExecution(withEv({ payer: MERCHANT })), 'payer mismatch');
  // 11. malformed execute() calldata
  expectThrow('11 malformed execute() calldata rejected',
    () => verifyUnitFlowExecution(withEv({ inputs: ['0x1234'] })), 'malformed execute() calldata');
  // 12. missing required execution evidence
  const missing = happyEvidence() as any;
  delete missing.merchantBalanceAfter;
  expectThrow('12 missing required execution evidence rejected',
    () => verifyUnitFlowExecution(missing), 'merchantBalanceAfter');
  // 13. unexpected recipient command sequence
  expectThrow('13 unexpected recipient command sequence rejected',
    () => verifyUnitFlowExecution(withEv({ commands: '0x01' })), 'unexpected recipient command sequence');
  // 14. invalid path token ordering (reversed legs)
  expectThrow('14 invalid path token ordering rejected',
    () => verifyUnitFlowExecution(withEv({ inputs: [reencode({ path: pathFor(EURC, 100, WUSDC) })] })), 'invalid path token ordering');
  // 15. invalid path encoding
  expectThrow('15 invalid path encoding rejected',
    () => verifyUnitFlowExecution(withEv({ inputs: [reencode({ path: '0x1234' as any })] })), 'invalid path encoding');
  // 16. unsafe/unsupported wrapper command sequence
  expectThrow('16 unsafe/unsupported wrapper command sequence rejected',
    () => verifyUnitFlowExecution(withEv({ commands: '0x0b00', inputs: ['0x', '0x'] } as any)), 'wrapper command sequence');
  // 17. replay identity surfaced for future shared uniqueness enforcement
  const r1 = verifyUnitFlowExecution(happyEvidence());
  const r2 = verifyUnitFlowExecution(happyEvidence());
  ok('17 replay identity surfaced deterministically', r1.executionTxHash === TXHASH && r2.executionTxHash === TXHASH);
  // 18. non-zero native value on the single-command execute() path
  expectThrow('18 non-zero native value rejected',
    () => verifyUnitFlowExecution(withEv({ value: 1n })), 'unexpected native value');
  // 19. known-dead alternate README router (0x09ea…) — same gate as foreign router
  expectThrow('19 known-dead router rejected',
    () => verifyUnitFlowExecution(withEv({ to: DEAD_ROUTER })), 'foreign UniversalRouter');
  // 20. dead-family evidence (dead Factory 0xb0bC… + dead router + dead-derived pool)
  //     — rejected by the same foreign-router gate before any pool check runs
  expectThrow('20 dead-factory family rejected',
    () => verifyUnitFlowExecution(withEv({
      deployment: { ...DEPLOYMENT, factory: DEAD_FACTORY },
      to: DEAD_ROUTER,
      pool: DEAD_POOL,
    })), 'foreign UniversalRouter');
  // 21. actual merchant balance decrease — distinct message from "below minOut"
  try {
    verifyUnitFlowExecution(withEv({ merchantBalanceBefore: 10_000n, merchantBalanceAfter: 9_000n }));
    ok('21 merchant balance decrease rejected', false, 'did NOT throw');
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    ok('21 merchant balance decrease rejected',
      msg.includes('balance decreased') && !msg.includes('below minOut'), msg.slice(0, 160));
  }

  console.log('── buildExecution() fail-closed arg validation (no RPC) ─────────');
  const buildThrows = async (label: string, input: any, needle: string) => {
    try { await buildUnitFlowV3Execution(input); ok(label, false, 'did NOT throw'); }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      ok(label, msg.includes(needle), msg.slice(0, 140));
    }
  };
  await buildThrows('same-symbol pair rejected', { inputSymbol: 'USDC', outputSymbol: 'USDC', inputAmount: 1n, merchantSCA: MERCHANT }, 'must differ');
  await buildThrows('zero input rejected', { inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 0n, merchantSCA: MERCHANT }, 'positive bigint');
  await buildThrows('client recipient shape rejected', { inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 1n, merchantSCA: 'not-an-address' }, 'merchantSCA');
  await buildThrows('bad fee tier rejected', { inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 1n, merchantSCA: MERCHANT, feeTier: 999 }, 'feeTier');
  await buildThrows('payer==merchant rejected', { inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 1n, merchantSCA: MERCHANT, expectedPayer: MERCHANT }, 'must not equal');

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}

main().catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); });
