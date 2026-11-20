// Real exported handlers with offline env/DB fixtures. No RPC, keys, or funds.
// Run: npx tsx --test tests/job-stream-availability.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { MAINNET_ENV, withEnv } from './fixtures/mainnet-env.mjs';
import { prisma } from '../src/lib/prisma.ts';

const configured = {
  ...MAINNET_ENV,
  ARC_MAINNET_STREAM_ADDRESS: '0x' + '6'.repeat(40),
  ARC_MAINNET_ERC8183_ADDRESS: '0x' + '9'.repeat(40),
  AGENT_OWNER_WALLET_ADDRESS: '',
};
const routes = {};
await withEnv(configured, async () => {
  for (const action of ['open', 'release', 'close']) {
    routes[action] = await import(`../src/app/api/jobs/nanopay/${action}/route.ts`);
  }
});

function replace(t, target, method, implementation) {
  const previous = target[method];
  target[method] = implementation;
  t.after(() => { target[method] = previous; });
}

function blockEffects(t) {
  const calls = [];
  const forbidden = (name) => () => {
    calls.push(name);
    throw new Error(`Forbidden effect: ${name}`);
  };
  t.mock.method(globalThis, 'fetch', forbidden('fetch'));
  for (const [delegate, methods] of Object.entries({
    apiKey: ['findUnique'], merchant: ['findUnique'], consumerAccount: ['findUnique'],
    erc8183Job: ['findUnique', 'update', 'updateMany'],
    jobNanopaymentStream: ['findUnique', 'create', 'update'],
    jobNanopaymentTranche: ['findUnique', 'create', 'update'],
  })) {
    for (const method of methods) replace(t, prisma[delegate], method, forbidden(`${delegate}.${method}`));
  }
  return calls;
}

const unavailable = [
  ['ERC-8183 absent (mainnet stream defaults verified)', { ...MAINNET_ENV }, 'erc8183_unavailable'],
  ['stream configured, ERC-8183 absent', { ...configured, ARC_MAINNET_ERC8183_ADDRESS: undefined }, 'erc8183_unavailable'],
  ['testnet stream absent', { ...MAINNET_ENV, ARC_NETWORK: 'testnet' }, 'stream_unavailable'],
];
for (const [action, route] of Object.entries(routes)) {
  for (const [label, env, error] of unavailable) {
    for (const credential of [false, true]) test(`${action}: ${label}, credential=${credential} refuses before auth/body/effects`, async (t) => {
      const calls = blockEffects(t);
      await withEnv(env, async () => {
        const req = new NextRequest(`https://app.example/api/jobs/nanopay/${action}`, {
          method: 'POST', headers: credential ? { 'x-api-key': 'offline-test-key' } : {}, body: '{',
        });
        t.mock.method(req, 'json', () => { throw new Error('Unavailable route must not parse body'); });
        const response = await route.POST(req);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.error, error);
        assert.ok(!body.txHash && !body.streamId);
        assert.deepEqual(calls, []);
      });
    });
  }

  test(`${action}: configured dependencies retain unauthenticated 401`, async (t) => {
    const calls = blockEffects(t);
    await withEnv(configured, async () => {
      const req = new NextRequest(`https://app.example/api/jobs/nanopay/${action}`, { method: 'POST', body: '{' });
      t.mock.method(req, 'json', () => { throw new Error('Unauthenticated route must not parse body'); });
      assert.equal((await route.POST(req)).status, 401);
      assert.deepEqual(calls, []);
    });
  });

  test(`${action}: verified default stream still requires authentication`, async (t) => {
    const calls = blockEffects(t);
    await withEnv({ ...configured, ARC_MAINNET_STREAM_ADDRESS: undefined }, async () => {
      const req = new NextRequest(`https://app.example/api/jobs/nanopay/${action}`, { method: 'POST', body: '{' });
      t.mock.method(req, 'json', () => { throw new Error('Unauthenticated route must not parse body'); });
      assert.equal((await route.POST(req)).status, 401);
      assert.deepEqual(calls, []);
    });
  });

  test(`${action}: configured dependencies retain invalid API-key rejection`, async (t) => {
    const calls = blockEffects(t);
    replace(t, prisma.apiKey, 'findUnique', async () => null);
    replace(t, prisma.merchant, 'findUnique', async () => null);
    await withEnv(configured, async () => {
      const req = new NextRequest(`https://app.example/api/jobs/nanopay/${action}`, {
        method: 'POST', headers: { 'x-api-key': 'invalid-offline-key' }, body: '{',
      });
      t.mock.method(req, 'json', () => { throw new Error('Invalid key must not parse body'); });
      assert.equal((await route.POST(req)).status, 401);
      assert.deepEqual(calls, []);
    });
  });

  test(`${action}: active service key cannot control another job wallet`, async (t) => {
    const calls = blockEffects(t);
    replace(t, prisma.apiKey, 'findUnique', async () => ({ active: true }));
    replace(t, prisma.merchant, 'findUnique', async () => null);
    replace(t, prisma.erc8183Job, 'findUnique', async () => ({
      jobId: 1n, status: 'FUNDED', budget: 100n,
      clientSCA: '0x' + 'a'.repeat(40), providerSCA: '0x' + 'b'.repeat(40), evaluatorSCA: '0x' + 'c'.repeat(40),
    }));
    replace(t, prisma.jobNanopaymentStream, 'findUnique', async () => ({ streamId: '1', trancheCount: 1, closedAt: null }));
    await withEnv(configured, async () => {
      const response = await route.POST(new NextRequest(`https://app.example/api/jobs/nanopay/${action}`, {
        method: 'POST', headers: { 'x-api-key': 'offline-service-key' },
        body: JSON.stringify({ jobId: '1', criteria: { requirements: ['delivery'] }, requirementIndex: 0 }),
      }));
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /do not control/);
      assert.deepEqual(calls, []);
    });
  });
}

test('opening still requires a FUNDED job; all routes retain ownership and consumer step-up gates', () => {
  for (const action of Object.keys(routes)) {
    const source = readFileSync(new URL(`../src/app/api/jobs/nanopay/${action}/route.ts`, import.meta.url), 'utf8');
    assert.ok(source.includes('verifyCallerControlsAddress('));
    assert.ok(source.includes('requireConsumerStepUpForActor('));
    assert.ok(source.includes('withApiKeyOrAnySession('));
    const post = source.slice(source.indexOf('export async function POST'));
    assert.ok(post.indexOf('erc8183AddressOr503()') < post.indexOf('return authenticated'));
    if (action === 'open') assert.ok(source.includes('job.status !== "FUNDED"'));
  }
});

test('job UI uses server-resolved availability and disables every protocol action', () => {
  const source = readFileSync(new URL('../src/app/jobs/page.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('const jobActionsUnavailable = !resolvedErc8183;'));
  assert.ok(source.includes('Pre-chain postings and read-only lists remain accessible.'));
  for (const action of ['approve', 'fund', 'accept', 'submit', 'complete']) {
    const control = source.slice(source.indexOf(`style={S.btnSm(manageAction === '${action}')}`));
    assert.ok(control.slice(0, control.indexOf('>')).includes('disabled={jobActionsUnavailable}'), `${action} disabled`);
  }
  for (const gate of [
    'disabled={stepLoading || jobActionsUnavailable}',
    'disabled={manageLoading || jobActionsUnavailable}',
    'disabled={selecting === p.id || jobActionsUnavailable}',
    'disabled={funding || jobActionsUnavailable}',
  ]) assert.ok(source.includes(gate), gate);
  for (const handler of ['callJobsAPI', 'runManageAction', 'selectAndHire', 'openFundTreasury', 'submitFundTreasury']) {
    const section = source.slice(source.indexOf(`const ${handler} =`));
    assert.ok(section.slice(0, section.indexOf('fetch(')).includes('if (jobActionsUnavailable)'), `${handler} early refusal`);
  }
});
