// Run: npx tsx --test tests/stream-legacy-unavailable.test.mjs
// Real exported handlers, mocked auth/DB and blocked network: no funds move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { Interface } from 'ethers';
import { prisma } from '../src/lib/prisma.ts';
import * as net from '../src/lib/config/network.ts';
import { ARC_FLARE_STREAM_ABI } from '../src/lib/contracts/streamContract.ts';
import * as create from '../src/app/api/payments/stream/create/route.ts';
import * as stop from '../src/app/api/payments/stream/stop/route.ts';
import * as withdraw from '../src/app/api/payments/stream/withdraw/route.ts';

const MAINNET_ENV = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://arcscan.example',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: '0x' + '2'.repeat(40),
  ARC_MAINNET_EURC_ADDRESS: '0x' + '3'.repeat(40),
  ARC_MAINNET_X402_VERIFIER: '0x' + '5'.repeat(40),
};
const ENVIRONMENTS = [
  ['configured testnet', { ARC_NETWORK: 'testnet', ARCFLARE_STREAM_CONTRACT_ADDRESS: net.TESTNET_STREAM_CONTRACT_ADDRESS }],
  // Format-valid fixture only, not a claim of a deployed mainnet contract.
  ['configured mainnet', { ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: '0x' + '6'.repeat(40) }],
  ['mainnet without streaming', MAINNET_ENV],
];
const ROUTES = { create, stop, withdraw };
const PAYLOADS = [
  ['legacy fields', JSON.stringify({
    senderSCA: '0x' + 'a'.repeat(40), receiverSCA: '0x' + 'b'.repeat(40),
    callerSCA: '0x' + 'a'.repeat(40), reference: 'legacy-stream',
    ratePerSecond: '0.000001', totalDeposited: '1', webhookUrl: 'https://must-not-be-called.example',
  })],
  ['empty body', '{}'],
  ['malformed JSON', '{'],
];

async function withEnv(env, fn) {
  const previous = { ...process.env };
  try {
    for (const key of ['ARC_NETWORK', 'NEXT_PUBLIC_ARC_NETWORK', 'ARC_MAINNET_STREAM_ADDRESS', 'ARCFLARE_STREAM_CONTRACT_ADDRESS', 'ARC_FLARE_STREAM_CONTRACT_ADDRESS']) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    net.__resetNetworkConfigCacheForTests();
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    net.__resetNetworkConfigCacheForTests();
  }
}

// Prisma delegates are proxies with synthetic property descriptors, so Node's
// mock.method cannot wrap them. Replace their methods and restore per test.
function replaceMethod(t, target, method, implementation) {
  const original = target[method];
  target[method] = implementation;
  t.after(() => { target[method] = original; });
}

function blockSideEffects(t, listing = false) {
  const calls = [];
  const forbidden = (name) => () => {
    calls.push(name);
    throw new Error(`Forbidden side effect: ${name}`);
  };
  replaceMethod(t, prisma.apiKey, 'findUnique', listing
    ? async () => ({ id: 1, key: 'test-key', active: true })
    : forbidden('apiKey.findUnique'));
  for (const method of ['findUnique', 'findMany', 'count', 'create', 'update', 'updateMany']) {
    if (listing && method === 'findMany') continue;
    replaceMethod(t, prisma.stream, method, forbidden(`stream.${method}`));
  }
  t.mock.method(globalThis, 'fetch', forbidden('network'));
  return calls;
}

test('real stream ABI supports only criterion-based writes, not legacy streaming', () => {
  const iface = new Interface(ARC_FLARE_STREAM_ABI);
  for (const signature of ['openStream(address,address,uint256,uint256)', 'releaseTranche(uint256,uint256)', 'closeStream(uint256)']) {
    assert.ok(iface.getFunction(signature));
  }
  for (const signature of ['createStream(address,uint256,uint256,string)', 'stopStream(bytes32)', 'withdraw(bytes32)']) {
    assert.equal(iface.getFunction(signature), null);
  }
  const open = readFileSync(new URL('../src/app/api/jobs/nanopay/open/route.ts', import.meta.url), 'utf8');
  assert.ok(open.includes('"openStream(address,address,uint256,uint256)"'));
  assert.ok(open.includes('[job.providerSCA, USDC_ADDRESS, totalBudget, trancheCount.toString()]'));
});

for (const [action, route] of Object.entries(ROUTES)) {
  for (const [environment, env] of ENVIRONMENTS) {
    for (const [payload, body] of PAYLOADS) {
      test(`${action}: ${environment}, ${payload} returns 503 with zero side effects`, async (t) => {
        const calls = blockSideEffects(t);
        await withEnv(env, async () => {
          const req = new NextRequest(`https://app.example/api/payments/stream/${action}`, {
            method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' }, body,
          });
          t.mock.method(req, 'json', () => { throw new Error('Unavailable streaming must not parse the body'); });
          const response = await route.POST(req);
          assert.equal(response.status, 503);
          const result = await response.json();
          assert.equal(result.success, false);
          if (environment === 'mainnet without streaming') {
            assert.equal(result.error, 'stream_unavailable');
          } else {
            assert.equal(result.error, `streaming ${action} is not available`);
            assert.equal(result.code, 'STREAM_ABI_CONFIG_CONFLICT');
            assert.match(result.message, /No funds have moved/);
          }
          assert.ok(!result.txHash && !result.stream, 'no fabricated transaction or stream');
          assert.deepEqual(calls, [], 'no stream DB access, wallet, RPC or webhook');
        });
      });
    }
  }
}

test('legacy create GET remains an authenticated read-only listing', async (t) => {
  const calls = blockSideEffects(t, true);
  replaceMethod(t, prisma.stream, 'findMany', async () => []);
  const response = await create.GET(new NextRequest('https://app.example/api/payments/stream/create', {
    headers: { 'x-api-key': 'test-key' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.streams, []);
  assert.equal(body.metrics.total, 0);
  assert.deepEqual(calls, []);
});

for (const [environment, env] of ENVIRONMENTS) test(`unauthenticated legacy POSTs return unavailable before auth: ${environment}`, async (t) => {
  const calls = blockSideEffects(t);
  await withEnv(env, async () => {
    for (const [action, route] of Object.entries(ROUTES)) {
      const req = new NextRequest(`https://app.example/api/payments/stream/${action}`, { method: 'POST', body: '{' });
      t.mock.method(req, 'json', () => { throw new Error('Unavailable route must not parse body'); });
      const response = await route.POST(req);
      assert.equal(response.status, 503);
      const result = await response.json();
      assert.equal(result.success, false);
      assert.equal(result.error, environment === 'mainnet without streaming' ? 'stream_unavailable' : `streaming ${action} is not available`);
    }
    assert.deepEqual(calls, []);
  });
});

test('legacy GET retains its API-key boundary', async (t) => {
  const calls = blockSideEffects(t);
  assert.equal((await create.GET(new NextRequest('https://app.example/api/payments/stream/create'))).status, 401);
  assert.deepEqual(calls, []);
});
