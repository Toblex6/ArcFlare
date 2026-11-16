// Run: npx tsx --test tests/mainnet-optional-features.test.mjs
// Real startup validator + route imports/handlers; mocked DB, blocked network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { BridgeChain } from '@circle-fin/bridge-kit';
import { MAINNET_ENV, withEnv } from './fixtures/mainnet-env.mjs';
import * as net from '../src/lib/config/network.ts';
import { assertWalletEnv, validateWalletEnv } from '../src/lib/env/walletEnvCheck.ts';
import { prisma } from '../src/lib/prisma.ts';
import { issueConsumerSessionToken } from '../src/lib/auth/consumerSession.ts';

const sources = JSON.stringify([{ id: BridgeChain.Ethereum, label: 'Ethereum', circleBlockchain: 'ETH' }]);
function replace(t, object, key, value) {
  const old = object[key]; object[key] = value;
  t.after(() => { object[key] = old; });
}
function blockEffects(t) {
  const calls = [];
  const forbidden = (name) => () => { calls.push(name); throw new Error(`Forbidden: ${name}`); };
  t.mock.method(globalThis, 'fetch', forbidden('fetch'));
  for (const [delegate, methods] of Object.entries({
    paymentLog: ['create', 'update'], apiListing: ['findUnique', 'update'],
    payrollBatch: ['findUnique', 'create', 'update'], stream: ['create', 'update'],
  })) for (const method of methods) replace(t, prisma[delegate], method, forbidden(`${delegate}.${method}`));
  return calls;
}
async function expect503(response, code) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.has('PAYMENT-REQUIRED'), false);
  assert.equal(response.headers.has('PAYMENT-RESPONSE'), false);
  const body = await response.json();
  assert.equal(body.code, code);
  if (code === 'x402_unavailable') assert.equal(body.error, 'x402 unavailable on mainnet');
}

test('mainnet boots without stream, x402 verifier or CCTP_MAINNET_* bridge config; core routes still work', async (t) => {
  const calls = blockEffects(t);
  await withEnv(MAINNET_ENV, async () => {
    const warnings = [];
    t.mock.method(console, 'warn', (message) => warnings.push(message));
    const result = validateWalletEnv();
    assert.deepEqual(result.errors, []);
    assertWalletEnv();
    assert.ok(warnings.some((warning) => warning.includes('ARC_MAINNET_STREAM_ADDRESS')));
    assert.equal(net.getNetworkConfig().streamAddress, null);
    assert.equal(net.getNetworkConfig().x402VerifierContract, null);
    // Import in this env, proving no eager bridge destination or paid wrapper.
    await import('../src/lib/cctp-v2.ts');
    await import('../src/app/api/agent/brain/route.ts');
    const network = await import('../src/app/api/network/route.ts');
    const response = await network.GET();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, 'mainnet');
    const marketplace = await import('../src/app/api/x402/marketplace/route.ts');
    replace(t, prisma.apiListing, 'findMany', async () => []);
    const listings = await marketplace.GET(new NextRequest('https://app.example/api/x402/marketplace'));
    assert.equal(listings.status, 200);
    assert.deepEqual(calls, []);
  });
});

for (const value of [undefined, '', '   ']) test(`missing/blank verifier ${JSON.stringify(value)} is null, never defaulted`, () => {
  const env = { ...MAINNET_ENV, ARC_MAINNET_X402_VERIFIER: value };
  assert.equal(net.getNetworkConfig(env).x402VerifierContract, null);
  assert.deepEqual(net.validateNetworkEnv(env), []);
  assert.ok(!net.MAINNET_REQUIRED_VARS.includes('ARC_MAINNET_X402_VERIFIER'));
});
for (const value of ['0x1234', 'not-an-address', net.getNetworkConfig({ ARC_NETWORK: 'testnet' }).x402VerifierContract]) {
  test(`invalid/foreign verifier ${value} remains startup-fatal`, () => {
    assert.throws(() => net.getNetworkConfig({ ...MAINNET_ENV, ARC_MAINNET_X402_VERIFIER: value }), /ARC_MAINNET_X402_VERIFIER/);
  });
}
test('configured verifier is retained; malformed stream still fails startup', () => {
  const verifier = '0x' + '8'.repeat(40);
  assert.equal(net.getNetworkConfig({ ...MAINNET_ENV, ARC_MAINNET_X402_VERIFIER: verifier }).x402VerifierContract, verifier);
  assert.ok(validateWalletEnv({ ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: 'bad' }).errors.some((e) => e.includes('ARC_MAINNET_STREAM_ADDRESS')));
  assert.equal(validateWalletEnv({ ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: verifier }).warnings.length, 0);
});

for (const verifier of [undefined, '0x' + '8'.repeat(40)]) {
for (const payment of [false, true]) test(`paid routes refuse before challenge/settlement, verifier=${verifier ? 'configured' : 'absent'}, signature=${payment}`, async (t) => {
  const calls = blockEffects(t);
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_X402_VERIFIER: verifier }, async () => {
    const headers = payment ? { 'payment-signature': Buffer.from('{}').toString('base64') } : {};
    const req = new NextRequest('https://app.example/api/agent/brain', { method: 'POST', headers, body: '{' });
    t.mock.method(req, 'json', () => { throw new Error('Unavailable paid route must not parse body'); });
    const brain = await import('../src/app/api/agent/brain/route.ts');
    await expect503(await brain.POST(req), 'x402_unavailable');
    const nano = await import('../src/app/api/nano/pay/[endpoint]/route.ts');
    await expect503(await nano.POST(req, { params: Promise.resolve({ endpoint: 'agent-lookup' }) }), 'x402_unavailable');
    const marketplace = await import('../src/app/api/x402/marketplace/pay/[slug]/route.ts');
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      await expect503(await marketplace[method](req, { params: Promise.resolve({ slug: 'test-listing' }) }), 'x402_unavailable');
    }
    const payroll = await import('../src/lib/payroll/payrollExecution.ts');
    await expect503(await payroll.fundPayrollViaX402(req, [{ address: MAINNET_ENV.BUYER_ADDRESS, amount: 1n }]), 'x402_unavailable');
    assert.deepEqual(calls, []);
  });
});
}

test('mainnet Gateway payroll refusal persists with a verifier, before settlement', async (t) => {
  const calls = blockEffects(t);
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_X402_VERIFIER: '0x' + '8'.repeat(40) }, async () => {
    const payroll = await import('../src/lib/payroll/payrollExecution.ts');
    await expect503(await payroll.fundPayrollViaX402(new NextRequest('https://app.example', {
      method: 'POST', headers: { 'payment-signature': Buffer.from('{}').toString('base64') },
    }), [{ address: MAINNET_ENV.BUYER_ADDRESS, amount: 1n }]), 'x402_unavailable');
    assert.deepEqual(calls, []);
  });
});

const invalidBridge = [
  ['both absent', {}], ['destination absent', { CCTP_MAINNET_SOURCES_JSON: sources }],
  ['sources absent', { CCTP_MAINNET_ARC_CHAIN_ID: 'Arc' }],
  ['malformed JSON', { CCTP_MAINNET_SOURCES_JSON: '{' }],
  ['empty sources', { CCTP_MAINNET_SOURCES_JSON: '[]' }],
  ['unknown source', { CCTP_MAINNET_SOURCES_JSON: JSON.stringify([{ id: 'unknown', label: 'unknown', circleBlockchain: 'ETH' }]) }],
  ...['5042', '26', 'Arc_Testnet', 'Ethereum', 'unknown'].map((id) => [id, { CCTP_MAINNET_SOURCES_JSON: sources, CCTP_MAINNET_ARC_CHAIN_ID: id }]),
];
for (const [label, config] of invalidBridge) test(`bridge configuration ${label} returns clean GET/POST/balance 503, no bridge started`, async (t) => {
  const calls = blockEffects(t);
  await withEnv({ ...MAINNET_ENV, ...config }, async () => {
    let lookups = 0;
    replace(t, prisma.consumerAccount, 'findUnique', async () => { lookups++; return { sessionVersion: 0 }; });
    const token = await issueConsumerSessionToken('test-consumer', MAINNET_ENV.BUYER_ADDRESS);
    const bridge = await import('../src/app/api/cctp/transfer/route.ts');
    await expect503(await bridge.GET(), 'cctp_unavailable');
    const req = new NextRequest('https://app.example/api/cctp/transfer', {
      method: 'POST', headers: { cookie: `consumer_token=${token}` }, body: '{',
    });
    t.mock.method(req, 'json', () => { throw new Error('Missing config must be refused before body/signing'); });
    await expect503(await bridge.POST(req), 'cctp_unavailable');
    const balance = await import('../src/app/api/cctp/transfer/balance/route.ts');
    await expect503(await balance.GET(new NextRequest('https://app.example/api/cctp/transfer/balance?fromChain=Ethereum', {
      headers: { cookie: `consumer_token=${token}` },
    })), 'cctp_unavailable');
    assert.equal(lookups, 2, 'only the two session lookups, no funding-wallet lookup');
    assert.deepEqual(calls, []);
  });
});

test('Arc is the installed mainnet BridgeChain NAME; configured discovery works without starting a bridge', async (t) => {
  const calls = blockEffects(t);
  await withEnv({ ...MAINNET_ENV, CCTP_MAINNET_SOURCES_JSON: sources, CCTP_MAINNET_ARC_CHAIN_ID: 'Arc' }, async () => {
    const cctp = await import('../src/lib/cctp-v2.ts');
    assert.equal(BridgeChain.Arc, 'Arc');
    const destination = cctp.getCctpDestination();
    assert.equal(destination.id, 'Arc');
    assert.equal(destination.destinationChainId, 5042);
    assert.equal(destination.destinationDomain, 26);
    const route = await import('../src/app/api/cctp/transfer/route.ts');
    assert.equal((await route.GET()).status, 200);
    assert.deepEqual(calls, []);
  });
});

test('testnet config and bridge discovery remain available; external bridge has no Circle-server dependency', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_NETWORK: 'testnet' }, async () => {
    const cctp = await import('../src/lib/cctp-v2.ts');
    assert.equal(cctp.getCctpDestination().id, 'Arc_Testnet');
    assert.ok(cctp.getCctpSources().every((chain) => chain.testnet));
    const guard = await import('../src/lib/x402/availability.ts');
    assert.equal(guard.x402UnavailableResponse(), null);
  });
  for (const path of ['intent', 'verify', 'complete']) {
    const code = readFileSync(new URL(`../src/app/api/cctp/transfer/external/${path}/route.ts`, import.meta.url), 'utf8');
    assert.ok(!/cctp-v2|CCTP_MAINNET_|cctpUnavailableResponse/.test(code));
  }
});

test('startBridge refuses missing credentials synchronously, never returns a fabricated pending reference', async (t) => {
  const calls = blockEffects(t);
  await withEnv({ ...MAINNET_ENV, CCTP_MAINNET_SOURCES_JSON: sources, CCTP_MAINNET_ARC_CHAIN_ID: 'Arc', CIRCLE_API_KEY: undefined }, async () => {
    const cctp = await import('../src/lib/cctp-v2.ts');
    const { CctpUnavailableError } = await import('../src/lib/bridge/cctpAvailability.ts');
    assert.throws(() => cctp.startBridge({
      fromChain: BridgeChain.Ethereum, toChain: 'Arc', amount: '0.000001',
      senderAddress: MAINNET_ENV.BUYER_ADDRESS, recipientAddress: MAINNET_ENV.SELLER_ADDRESS,
    }), (error) => error instanceof CctpUnavailableError && error.message.includes('credentials'));
    assert.deepEqual(calls, []);
  });
});
