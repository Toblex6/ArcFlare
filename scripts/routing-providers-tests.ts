// scripts/routing-providers-tests.ts
//
// Phase 1 provider-foundation tests (Tower + UnitFlow Swap Integration).
// Pure unit tests: no RPC, no DB, no funds, no network. Run:
//   npx tsx scripts/routing-providers-tests.ts
//
// Covers:
//   normalize.ts: valid 6-decimal passthrough, mismatched-decimals rejection,
//     unknown-venue rejection (+ unknown-token rejection).
//   registry.ts: unknown registration throws, disabled venue not active
//     (+ canonical-first / canonical-only-by-default / fail-closed select).
//
// Existing routing suites (routing-quote-tests, routing-verify-tests, …) are
// untouched — this file asserts provider modules in isolation.

import { normalizeProviderQuote } from '@/src/lib/routing/providers/normalize';
import { createVenueRegistry, isVenueEnabled, VenueRegistry } from '@/src/lib/routing/providers/registry';
import { PROVIDER_NOT_IMPLEMENTED, type SwapProvider } from '@/src/lib/routing/providers/types';
import { TowerProvider } from '@/src/lib/routing/providers/tower';
import { UnitFlowV3Provider } from '@/src/lib/routing/providers/unitflowV3';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
function expectThrow(label: string, fn: () => unknown, needle?: string) {
  try {
    fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    ok(label, !needle || String(e?.message ?? '').includes(needle), String(e?.message ?? e).slice(0, 120));
  }
}

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

function stubProvider(venueId: any): SwapProvider {
  return {
    venueId,
    quote: async () => { throw new Error('stub'); },
    buildExecution: async () => { throw new Error('stub'); },
    verifyExecution: async () => { throw new Error('stub'); },
  } as unknown as SwapProvider;
}

async function normalizeTests() {
  console.log('── normalize: provider output → canonical base units ──────────────');
  const good = normalizeProviderQuote({
    venueId: 'tower',
    inputToken: USDC,
    outputToken: EURC,
    inputAmount: '1000000',
    outputAmount: '990000',
    inputDecimals: 6,
    outputDecimals: 6,
    minOut: '980000',
  });
  ok('valid 6-decimal passthrough', good.venueId === 'tower' && good.inputAmount === 1000000n && good.quotedOutputAmount === 990000n && good.minOutputAmount === 980000n);
  ok('canonical token identity resolved (6/6)', good.inputToken.decimals === 6 && good.outputToken.decimals === 6 && good.inputToken.address === USDC && good.outputToken.address === EURC);
  const noClaim = normalizeProviderQuote({
    venueId: 'unitflow-v3', inputToken: USDC, outputToken: EURC, inputAmount: '1000000', outputAmount: '990000',
  });
  ok('no-decimals-claim passthrough accepted', noClaim.quotedOutputAmount === 990000n);

  expectThrow('mismatched output decimals rejected', () => normalizeProviderQuote({
    venueId: 'tower', inputToken: USDC, outputToken: EURC, inputAmount: '1000000', outputAmount: '990000', outputDecimals: 18,
  }), 'decimals mismatch');
  expectThrow('mismatched input decimals rejected', () => normalizeProviderQuote({
    venueId: 'tower', inputToken: USDC, outputToken: EURC, inputAmount: '1000000', outputAmount: '990000', inputDecimals: 8,
  }), 'decimals mismatch');
  expectThrow('unknown venue rejected', () => normalizeProviderQuote({
    venueId: 'nope-dex', inputToken: USDC, outputToken: EURC, inputAmount: '1000000', outputAmount: '990000',
  }), 'Unknown venue');
  expectThrow('unknown token rejected', () => normalizeProviderQuote({
    venueId: 'tower', inputToken: '0x0000000000000000000000000000000000000001', outputToken: EURC, inputAmount: '1000000', outputAmount: '990000',
  }), 'not a supported');
  expectThrow('non-integer amount rejected', () => normalizeProviderQuote({
    venueId: 'tower', inputToken: USDC, outputToken: EURC, inputAmount: 'abc', outputAmount: '990000',
  }), 'not an integer');
}

async function registryTests() {
  console.log('── registry: venues, flags, fail-closed selection ─────────────────');
  const OFF = {};
  ok('canonical enabled by default', isVenueEnabled('canonical', OFF) === true);
  ok('tower defaults disabled', isVenueEnabled('tower', OFF) === false);
  ok('unitflow-v3 defaults disabled', isVenueEnabled('unitflow-v3', OFF) === false);
  ok('tower flag opt-in ("1")', isVenueEnabled('tower', { ROUTING_PROVIDER_TOWER_ENABLED: '1' }) === true);
  ok('unitflow flag opt-in ("true")', isVenueEnabled('unitflow-v3', { ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: 'true' }) === true);

  const reg = new VenueRegistry();
  expectThrow('unknown registration throws', () => reg.register(stubProvider('nope-dex')), 'Unknown venue');

  const def = createVenueRegistry();
  ok('canonical registers first', def.registeredVenues()[0] === 'canonical');
  const activeOff = def.getActiveProviders(OFF);
  ok('canonical is the only active venue by default', activeOff.length === 1 && activeOff[0]!.venueId === 'canonical');

  const full = createVenueRegistry([new TowerProvider(), new UnitFlowV3Provider()]);
  const activeStillOff = full.getActiveProviders(OFF);
  ok('disabled venues are never returned as active', activeStillOff.length === 1 && activeStillOff.every((p) => p.venueId === 'canonical'));
  const activeTower = full.getActiveProviders({ ROUTING_PROVIDER_TOWER_ENABLED: '1' });
  ok('enabled tower becomes active (canonical still first)', activeTower.length === 2 && activeTower[0]!.venueId === 'canonical' && activeTower[1]!.venueId === 'tower');

  expectThrow('select disabled venue fails closed', () => full.selectProvider('tower', OFF), 'disabled');
  expectThrow('select unknown venue fails closed', () => full.selectProvider('nope-dex', OFF), 'Unknown venue');
  expectThrow('select unregistered venue fails closed', () => createVenueRegistry().selectProvider('tower', { ROUTING_PROVIDER_TOWER_ENABLED: '1' }), 'not registered');
  ok('select enabled venue returns it', full.selectProvider('tower', { ROUTING_PROVIDER_TOWER_ENABLED: '1' }).venueId === 'tower');

  for (const p of [new TowerProvider(), new UnitFlowV3Provider()]) {
    for (const op of ['buildExecution', 'verifyExecution'] as const) {
      try { await (p as any)[op](); ok(`${p.venueId} ${op} throws NOT_IMPLEMENTED`, false, 'did NOT throw'); }
      catch (e: any) { ok(`${p.venueId} ${op} throws NOT_IMPLEMENTED`, (e as any)?.code === PROVIDER_NOT_IMPLEMENTED || String(e?.message ?? '').includes(PROVIDER_NOT_IMPLEMENTED)); }
    }
  }
  try { await new UnitFlowV3Provider().quote({ inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: 1n }); ok('unitflow quote throws NOT_IMPLEMENTED', false, 'did NOT throw'); }
  catch (e: any) { ok('unitflow quote throws NOT_IMPLEMENTED', String(e?.message ?? '').includes(PROVIDER_NOT_IMPLEMENTED)); }
}

async function main() {
  await normalizeTests();
  await registryTests();
  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
}

main().catch((e) => { console.error('test threw:', e?.message ?? e); process.exit(1); });
