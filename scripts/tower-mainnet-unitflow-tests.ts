// scripts/tower-mainnet-unitflow-tests.ts
//
// Focused tests for the Arc Mainnet UnitFlowV3 + Tower integration stage.
// Pure/offline except the Tower failure-fallback case (connection-refused
// localhost, no external network) — no funds, no signing, no broadcasts,
// no real mainnet swap.
//
// Run: npx tsx scripts/tower-mainnet-unitflow-tests.ts
//
// Covers:
//   A. mainnet vs testnet UnitFlow configuration (pins, chain ids, atomicity)
//   B. mainnet execution never selects testnet addresses (fail-closed first)
//   C. Tower mainnet configuration (shared gateway, scopes, fail-closed auth)
//   D. missing Tower credentials + Tower unavailable/failure fallback
//   E. no false Tower attribution (shouldShowTowerAttribution matrix)
//   F. mainnet token identity for the Tower quote path (network-aware)
// Existing suites (routing-providers, unitflow-execution, swap-backend,
// network-config, network-centralization) are untouched.

import {
  assertUnitFlowDeploymentComplete,
  getUnitFlowV3Deployment,
  MAINNET_V3_FAMILY,
  UNITFLOW_MAINNET_CHAIN_ID_PIN,
} from '@/src/lib/config/unitflow';
import {
  __resetNetworkConfigCacheForTests,
  getNetworkConfig,
} from '@/src/lib/config/network';
import { getTokenByAddress, getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import { normalizeProviderQuote } from '@/src/lib/routing/providers/normalize';
import {
  getTowerConfig,
  getTowerStatus,
  TOWER_SWAP_BASE_URL_DEFAULT,
} from '@/src/lib/routing/providers/tower';
import { getTowerCandidate } from '@/src/lib/swap/service';
import { buildUnitFlowV3Execution } from '@/src/lib/routing/providers/unitflowV3';
import { shouldShowTowerAttribution } from '@/src/components/swap/swapCopy';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}
function expectThrow(label: string, fn: () => unknown, needle: string) {
  try {
    fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    ok(label, String(e?.message ?? e).includes(needle), String(e?.message ?? e).slice(0, 160));
  }
}
async function expectThrowAsync(label: string, fn: () => Promise<unknown>, needle: string) {
  try {
    await fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    ok(label, String(e?.message ?? e).includes(needle), String(e?.message ?? e).slice(0, 160));
  }
}

// Testnet pins (must never appear in a mainnet execution path).
const TESTNET_PINS = [
  '0xAb6A8AAb7d490007634ef59d424b5d89688a1971', // factory
  '0x121aeB6DEf00F6F67665008CaC1C19805886ed1a', // quoter
  '0xEaF3195bE51861632cd32850973C9515DA48e76F', // universalRouter
  '0x4ce562F687d0Ced27b79Ba51d79B63BD978F7F48', // permit2
  '0x911b4000D3422F482F4062a913885f7b035382Df', // wusdc
];
const lower = (s: string) => s.toLowerCase();

// Distinct mainnet token placeholders (NOT copied from testnet).
const MM_USDC = '0x' + '2'.repeat(40);
const MM_EURC = '0x' + '3'.repeat(40);
const MAINNET_ENV_BASE = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.example',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: MM_USDC,
  ARC_MAINNET_EURC_ADDRESS: MM_EURC,
  ARC_MAINNET_ERC8183_ADDRESS: '0x' + '4'.repeat(40),
  ARC_MAINNET_X402_VERIFIER: '0x' + '5'.repeat(40),
};
// Executor-side mainnet inputs (throwaway distinct addresses — never funded).
const MAINNET_EXEC_ENV = {
  UNITFLOW_MAINNET_UNIVERSAL_ROUTER: '0x' + 'a'.repeat(40),
  UNITFLOW_MAINNET_PERMIT2: '0x' + 'b'.repeat(40),
  UNITFLOW_MAINNET_WUSDC: '0x' + 'c'.repeat(40),
};

/** Run fn with process.env patched (network-cache safe), then restore. */
async function withProcessEnv(env: Record<string, string>, fn: () => void | Promise<void>) {
  const prev = new Map<string, string | undefined>();
  for (const k of Object.keys(env)) {
    prev.set(k, process.env[k]);
    process.env[k] = env[k];
  }
  __resetNetworkConfigCacheForTests();
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetNetworkConfigCacheForTests();
  }
}

async function configTests() {
  console.log('── A. mainnet vs testnet UnitFlow configuration ────────────────');
  const testnet = getUnitFlowV3Deployment({});
  ok('testnet pins unchanged',
    testnet.name === 'testnet' && testnet.chainId === 5042002 &&
    testnet.factory === TESTNET_PINS[0] && testnet.quoter === TESTNET_PINS[1] &&
    testnet.universalRouter === TESTNET_PINS[2] && testnet.permit2 === TESTNET_PINS[3] &&
    testnet.wusdc === TESTNET_PINS[4]);
  ok('testnet carries no mainnet family fields',
    testnet.v3Router === undefined && testnet.positionManager === undefined);

  expectThrow('mainnet without executor env still fails closed',
    () => getUnitFlowV3Deployment({ ARC_NETWORK: 'mainnet' }), 'missing');

  const mm = getUnitFlowV3Deployment({ ARC_NETWORK: 'mainnet', ...MAINNET_EXEC_ENV });
  ok('mainnet factory/quoter default to supplied pins',
    mm.name === 'mainnet' &&
    mm.factory === MAINNET_V3_FAMILY.factory &&
    mm.quoter === MAINNET_V3_FAMILY.quoter);
  ok('mainnet chain defaults to pinned 5042',
    mm.chainId === 5042 && UNITFLOW_MAINNET_CHAIN_ID_PIN === 5042);
  ok('mainnet carries the full 9-address V3 family',
    mm.v3Router === '0x6fD8351b9596C1F0b2f2479BfA6A171cb3d0f410' &&
    mm.positionManager === '0x300F5f2861eF0d9D3c6B812797C0A4c8b15C86a8' &&
    mm.multicall === '0xc9E1780bA34698C1067EA6B2fcF78f111a5F110b' &&
    mm.tickLens === '0x20Df732207340234E490a1e686A3A8055AF59b4e' &&
    mm.nftDescriptor === '0x9Ca8e324380Aa2E80011A16C4d684366E47d4Ab4' &&
    mm.positionDescriptor === '0x5Bc0735F5D806C184EDE0A7731632F7c491B3B02' &&
    mm.migrator === '0x36E9b24b9CF39c4C7069B75f01FA0419547F977a');
  ok('mainnet executor inputs come from env (fail-closed, never testnet)',
    mm.universalRouter === MAINNET_EXEC_ENV.UNITFLOW_MAINNET_UNIVERSAL_ROUTER &&
    mm.permit2 === MAINNET_EXEC_ENV.UNITFLOW_MAINNET_PERMIT2 &&
    mm.wusdc === MAINNET_EXEC_ENV.UNITFLOW_MAINNET_WUSDC);

  // Explicit operator overrides win over pins (still validated).
  const over = getUnitFlowV3Deployment({
    ARC_NETWORK: 'mainnet',
    ...MAINNET_EXEC_ENV,
    UNITFLOW_MAINNET_FACTORY: '0x' + 'd'.repeat(40),
    UNITFLOW_MAINNET_QUOTER: '0x' + 'e'.repeat(40),
    UNITFLOW_MAINNET_CHAIN_ID: '5042',
  });
  ok('explicit mainnet factory/quoter env overrides pins',
    over.factory === '0x' + 'd'.repeat(40) && over.quoter === '0x' + 'e'.repeat(40));
  expectThrow('malformed mainnet factory override fails closed',
    () => getUnitFlowV3Deployment({ ARC_NETWORK: 'mainnet', ...MAINNET_EXEC_ENV, UNITFLOW_MAINNET_FACTORY: 'nope' }),
    'must be a 0x EVM address');

  // No testnet address anywhere in the mainnet deployment object.
  const mmValues = JSON.stringify(mm).toLowerCase();
  ok('mainnet deployment contains zero testnet addresses',
    TESTNET_PINS.every((p) => !mmValues.includes(p.toLowerCase())));
  // No mainnet pin inside the testnet deployment object.
  const tnValues = JSON.stringify(testnet).toLowerCase();
  ok('testnet deployment contains zero mainnet addresses',
    Object.values(MAINNET_V3_FAMILY).every((a) => !tnValues.includes(lower(a))));
  try {
    assertUnitFlowDeploymentComplete(mm);
    ok('complete mainnet deployment asserts clean', true);
  } catch (e: any) {
    ok('complete mainnet deployment asserts clean', false, String(e?.message ?? e));
  }
}

async function executionSafetyTests() {
  console.log('── B. mainnet execution never selects testnet addresses ────────');
  const MERCHANT = '0xc119bb61dCd7Ce422557485ecD17D679f44250a1';
  // Missing executor env: build throws during deployment resolution — before
  // any pool/router/token use, hence before any testnet address could load.
  await expectThrowAsync('mainnet build without executor env fails before RPC',
    () => buildUnitFlowV3Execution(
      { inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 10000n, merchantSCA: MERCHANT },
      { ARC_NETWORK: 'mainnet' }
    ), 'missing');
  // Even arg validation runs first; deployment gating follows — either way no RPC.
  await expectThrowAsync('mainnet build arg validation still first',
    () => buildUnitFlowV3Execution(
      { inputSymbol: 'USDC', outputSymbol: 'USDC', inputAmount: 1n, merchantSCA: MERCHANT },
      { ARC_NETWORK: 'mainnet', ...MAINNET_EXEC_ENV }
    ), 'must differ');
}

function towerConfigTests() {
  console.log('── C. Tower mainnet configuration ──────────────────────────────');
  ok('default gateway root is https://www.tower.exchange',
    TOWER_SWAP_BASE_URL_DEFAULT === 'https://www.tower.exchange');
  expectThrow('missing API key fails closed (503)',
    () => getTowerConfig({}), 'TOWER_SWAP_API_KEY missing');
  expectThrow('non-https base URL rejected',
    () => getTowerConfig({ TOWER_SWAP_API_KEY: 'sk_test_abc', TOWER_SWAP_BASE_URL: 'http://evil.example' }),
    'must be https');

  // Same gateway + same key model serves both networks (official docs).
  const st = getTowerStatus({ ARC_NETWORK: 'testnet', ROUTING_PROVIDER_TOWER_ENABLED: '1', TOWER_SWAP_API_KEY: 'sk_test_abc' });
  const sm = getTowerStatus({ ARC_NETWORK: 'mainnet', ROUTING_PROVIDER_TOWER_ENABLED: '1', TOWER_SWAP_API_KEY: 'sk_live_abc' });
  ok('status reflects selected network', st.network === 'testnet' && sm.network === 'mainnet');
  ok('same gateway root on both networks', st.baseUrl === sm.baseUrl && st.baseUrl === TOWER_SWAP_BASE_URL_DEFAULT);
  ok('configured when flag on + key present', st.configured === true && sm.configured === true);
  const off = getTowerStatus({});
  ok('flag-off reports unconfigured without touching network', off.configured === false && off.keyPresent === false);
  const nokey = getTowerStatus({ ROUTING_PROVIDER_TOWER_ENABLED: 'true' });
  ok('missing key reports unconfigured (no placeholder invented)',
    nokey.configured === false && nokey.reason.includes('no API key'));
}

async function towerFallbackTests() {
  console.log('── D. Tower unavailable/failure fallback ───────────────────────');
  const noFlag = await getTowerCandidate({ inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 10000n, env: {} });
  ok('flag-off fallback: consulted=false, available=false, no throw',
    noFlag.consulted === false && noFlag.available === false);
  const noKey = await getTowerCandidate({
    inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 10000n,
    env: { ROUTING_PROVIDER_TOWER_ENABLED: '1' },
  });
  ok('missing-key fallback: consulted=true (attempted), available=false',
    noKey.consulted === true && noKey.available === false && noKey.note.includes('API key'));
  // Unreachable gateway: real failure path, connection-refused localhost —
  // fast, no external network, must fall back (never throw).
  const dead = await getTowerCandidate({
    inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 10000n,
    env: {
      ROUTING_PROVIDER_TOWER_ENABLED: '1',
      TOWER_SWAP_API_KEY: 'sk_test_unreachable',
      TOWER_SWAP_BASE_URL: 'https://127.0.0.1:9',
    },
  });
  ok('unreachable-Tower fallback: consulted=true, available=false, no throw',
    dead.consulted === true && dead.available === false);
}

function attributionTests() {
  console.log('── E. no false Tower attribution ───────────────────────────────');
  ok('null tower → no attribution', shouldShowTowerAttribution(null) === false);
  ok('undefined tower → no attribution', shouldShowTowerAttribution(undefined) === false);
  ok('flag-off {false,false} → no attribution',
    shouldShowTowerAttribution({ consulted: false, available: false }) === false);
  ok('missing-key {true,false} → no attribution',
    shouldShowTowerAttribution({ consulted: true, available: false }) === false);
  ok('failure {true,false} → no attribution',
    shouldShowTowerAttribution({ consulted: true, available: false }) === false);
  ok('consulted+available → attribution',
    shouldShowTowerAttribution({ consulted: true, available: true }) === true);
}

async function mainnetTokenTests() {
  console.log('── F. mainnet token identity for the Tower quote path ──────────');
  await withProcessEnv(MAINNET_ENV_BASE, () => {
    const cfg = getNetworkConfig();
    ok('mainnet network selected', cfg.name === 'mainnet' && cfg.chainId === 5042);
    const usdc = getTokenBySymbol('USDC');
    const eurc = getTokenBySymbol('EURC');
    ok('Tower quote source resolves mainnet USDC/EURC (never testnet pins)',
      usdc.address === MM_USDC && eurc.address === MM_EURC);
    // Tower comparison normalizes mainnet USDC→EURC without throwing
    // (cirBTC skip keeps unconfigured symbols from breaking lookup).
    const q = normalizeProviderQuote({
      venueId: 'tower',
      inputToken: MM_USDC,
      outputToken: MM_EURC,
      inputAmount: '1000000',
      outputAmount: '990000',
    });
    ok('mainnet Tower-shape quote normalizes on mainnet identity',
      q.inputToken.address === MM_USDC && q.outputToken.address === MM_EURC);
    expectThrow('cirBTC still refuses on mainnet (testnet-only)',
      () => getTokenBySymbol('CIRBTC'), 'not configured for mainnet');
    ok('mainnet testnet-EURC pin is not the selected EURC',
      getTokenByAddress('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a')?.address !== MM_EURC);
  });
  // Process env restored: testnet identity back.
  const usdc = getTokenBySymbol('USDC');
  ok('testnet identity restored after mainnet section',
    usdc.address === '0x3600000000000000000000000000000000000000');
}

async function main() {
  await configTests();
  await executionSafetyTests();
  towerConfigTests();
  await towerFallbackTests();
  attributionTests();
  await mainnetTokenTests();
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}

main().catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); });
