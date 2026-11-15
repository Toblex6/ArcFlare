// Run: npx tsx --test tests/mainnet-escrow-admin-env.test.mjs
// Startup matrix + actual dispute handler; no DB, RPC, or fund movement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { MAINNET_ENV, withEnv } from './fixtures/mainnet-env.mjs';
import { validateWalletEnv, assertWalletEnv } from '../src/lib/env/walletEnvCheck.ts';
import { prisma } from '../src/lib/prisma.ts';

const mainnetEscrow = '0x' + '8'.repeat(40); // format-valid fixture, not a deployment claim
const withoutKey = { ...MAINNET_ENV, ESCROW_ADMIN_PRIVATE_KEY: undefined };
for (const address of [undefined, '', '   ']) test(`mainnet escrow address ${JSON.stringify(address)} allows missing escrow-admin key`, (t) => {
  const env = { ...withoutKey, ARC_MAINNET_ESCROW_ADDRESS: address };
  const result = validateWalletEnv(env);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(result.warnings.some((w) => w.includes('ESCROW_ADMIN_PRIVATE_KEY')));
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  assert.doesNotThrow(() => assertWalletEnv(env));
  assert.ok(warnings.some((w) => w.includes('no mainnet escrow')));
});
test('legacy testnet escrow variable never makes the mainnet escrow-admin key required', () => {
  const result = validateWalletEnv({ ...withoutKey, ARCFLARE_ESCROW_CONTRACT_ADDRESS: mainnetEscrow });
  assert.equal(result.ok, true, result.errors.join('; '));
});
test('configured mainnet escrow still requires its admin key', () => {
  const result = validateWalletEnv({ ...withoutKey, ARC_MAINNET_ESCROW_ADDRESS: mainnetEscrow });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('ESCROW_ADMIN_PRIVATE_KEY')));
});
test('configured mainnet escrow with a valid admin key passes startup', () => {
  const result = validateWalletEnv({ ...MAINNET_ENV, ARC_MAINNET_ESCROW_ADDRESS: mainnetEscrow });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(!result.warnings.some((w) => w.includes('ESCROW_ADMIN_PRIVATE_KEY')));
});
for (const configured of [false, true]) for (const key of ['YOUR_KEY', '0x1234', '0x' + '00'.repeat(32), '0x' + 'ff'.repeat(32)]) {
  test(`invalid supplied escrow-admin key is rejected even with escrow ${configured ? 'configured' : 'disabled'}: ${key.slice(0, 12)}`, () => {
    const result = validateWalletEnv({
      ...MAINNET_ENV, ARC_MAINNET_ESCROW_ADDRESS: configured ? mainnetEscrow : undefined, ESCROW_ADMIN_PRIVATE_KEY: key,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('ESCROW_ADMIN_PRIVATE_KEY')));
  });
}
test('testnet still requires the escrow-admin key, even without an escrow address', () => {
  const result = validateWalletEnv({ ...withoutKey, ARC_NETWORK: 'testnet', ARCFLARE_STREAM_CONTRACT_ADDRESS: mainnetEscrow });
  assert.ok(result.errors.some((e) => e.includes('ESCROW_ADMIN_PRIVATE_KEY')));
});
for (const key of ['EOA_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY', 'ARC_ADMIN_PRIVATE_KEY']) test(`disabled escrow does not relax ${key}`, () => {
  const result = validateWalletEnv({ ...withoutKey, [key]: undefined });
  assert.ok(result.errors.some((e) => e.includes(key)));
});
test('invalid core mainnet config remains startup-fatal with no escrow key', () => {
  const result = validateWalletEnv({ ...withoutKey, ARC_MAINNET_RPC_URL: undefined });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('ARC_MAINNET_RPC_URL')));
});
test('mainnet without escrow or admin key: dispute resolution returns 503 before auth/body/DB/signing', async (t) => {
  await withEnv(withoutKey, async () => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', () => { calls.push('network'); throw new Error('No network allowed'); });
    const old = prisma.escrow.findUnique;
    prisma.escrow.findUnique = () => { calls.push('escrow.findUnique'); throw new Error('No DB allowed'); };
    t.after(() => { prisma.escrow.findUnique = old; });
    const route = await import('../src/app/api/admin/disputes/[reference]/resolve/route.ts');
    const req = new NextRequest('https://app.example/api/admin/disputes/test/resolve', { method: 'POST', body: '{' });
    t.mock.method(req, 'json', () => { throw new Error('No body parsing allowed'); });
    const response = await route.POST(req, { params: Promise.resolve({ reference: 'test' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'escrow_unavailable');
    assert.deepEqual(calls, []);
  });
});
