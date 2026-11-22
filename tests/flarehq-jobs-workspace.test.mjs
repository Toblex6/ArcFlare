// Offline actual wallet-list handler + actual client action function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const client = `0x${'ab'.repeat(20)}`, provider = `0x${'cd'.repeat(20)}`;
const page = file('src/app/flarehq-jobs/page.tsx');
const ast = ts.createSourceFile('jobs.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function find(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'act') handler = node; ts.forEachChild(node, find); }
find(ast);
assert.ok(handler);
const compiled = ts.transpileModule(`${handler.getText(ast)}; return act;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function setup(options = {}) {
  const calls = [], errors = [], prompts = [], pending = [], lock = { current: false };
  const actor = { address: client, mode: 'CIRCLE', actorType: 'merchant', ...options.actor };
  let refreshes = 0;
  const readJson = async (r) => r.json();
  const fetch = async (url, init) => { calls.push({ url, init }); return { json: async () => url === '/api/consumer/security' ? { success: true, walletAddress: options.securityWallet ?? client, hasPin: true } : options.response ?? { success: true } }; };
  const proof = 'synthetic-step-up-proof';
  const requestPin = async (p) => { prompts.push(p); return options.cancel ? null : proof; };
  const names = ['running', 'walletAction', 'actor', 'setBusy', 'setError', 'setMessage', 'address', 'same', 'readJson', 'fetch', 'requestPin', 'selectedId', 'setSelected', 'setTab', 'setWalletAction', 'load'];
  const values = [lock, null, actor, () => {}, (e) => errors.push(e), () => {}, options.connectedAddress, same, readJson, fetch, requestPin, { current: null }, () => {}, () => {}, (v) => pending.push(v), async () => { refreshes++; }];
  return { act: new Function(...names, compiled)(...values), calls, errors, prompts, pending, lock, proof, refreshes: () => refreshes };
}

test('Circle session wallet can post without a browser wallet connection', async () => {
  const s = setup(); await s.act('/api/flarehq-jobs', { clientAddress: client, description: 'Test work', budget: '0.05' });
  assert.equal(s.calls.length, 1); assert.equal(s.errors.at(-1), null); assert.equal(s.refreshes(), 1);
});
test('external party must match the connected browser signer; never substitutes a Circle payer', async () => {
  const s = setup({ actor: { mode: 'EXTERNAL' }, connectedAddress: provider });
  await s.act('/api/flarehq-jobs/job1/fund', {}); assert.equal(s.calls.length, 0); assert.ok(s.errors.at(-1));
});
test('consumer Circle money action uses fresh security + transient masked proof', async () => {
  const s = setup({ actor: { actorType: 'consumer' } }); await s.act('/api/flarehq-jobs/job1/fund', {});
  assert.equal(s.prompts.length, 1); assert.equal(s.calls.length, 2);
  assert.ok(s.calls[1].init.headers['x-consumer-pin'] === s.proof);
  assert.ok(!s.calls[1].init.body.includes(s.proof)); assert.equal(s.refreshes(), 1);
});
test('cancel or mismatched consumer security sends no action', async () => {
  for (const options of [{ cancel: true }, { securityWallet: provider }]) {
    const s = setup({ ...options, actor: { actorType: 'consumer' } }); await s.act('/api/flarehq-jobs/job1/select', {});
    assert.equal(s.calls.length, 1); assert.equal(s.refreshes(), 0); assert.equal(s.lock.current, false);
  }
});
test('double click cannot post a second action while first is pending', async () => {
  const s = setup(); const first = s.act('/api/flarehq-jobs', {}); await s.act('/api/flarehq-jobs', {}); await first;
  assert.equal(s.calls.length, 1); assert.equal(s.lock.current, false);
});
test('external intents retain server-authored transaction and confirmation targets', async () => {
  const transaction = { from: client, to: provider, value: '0' }, confirm = { endpoint: '/api/flarehq-jobs/job1/fund/confirm' };
  const s = setup({ actor: { mode: 'EXTERNAL' }, connectedAddress: client, response: { success: true, pendingWallet: true, transaction, confirm } });
  await s.act('/api/flarehq-jobs/job1/fund', {}); assert.deepEqual(s.pending, [{ transactions: [transaction], confirm }]);
});

function walletRoute(options = {}) {
  const source = ts.transpileModule(file('src/app/api/flarehq-jobs/wallets/route.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const checked = [], resolved = [], module = { exports: {} };
  const stubs = {
    'next/server': { NextResponse: { json: (value, init) => new Response(JSON.stringify(value), init) } },
    '@/lib/ratelimit': { checkRateLimit: async () => options.limited ? { allowed: false, response: new Response('{}', { status: 429 }) } : { allowed: true } },
    '@/lib/wallet/verifyCallerControlsAddress': {
      getCallerControlledAddresses: async () => new Set(options.anonymous ? [] : [client, provider]),
      verifyCallerControlsAddress: async (_req, address) => { checked.push(address); return address === provider && options.revoke ? null : { type: 'consumer' }; },
    },
    '@/lib/jobs/flarehqEscrowActions': { resolveExactJobWallet: async (address) => { resolved.push(address); return { address, mode: 'CIRCLE', source: 'consumer', circleWalletId: 'private-wallet-id' }; } },
  };
  new Function('require', 'module', 'exports', source)((name) => { if (Object.hasOwn(stubs, name)) return stubs[name]; throw new Error('Unexpected dependency'); }, module, module.exports);
  return { GET: module.exports.GET, checked, resolved };
}
test('wallet choices recheck canonical ownership and never expose Circle wallet ids', async () => {
  const s = walletRoute({ revoke: true }); const r = await s.GET({}); const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.wallets.length, 1); assert.equal(body.wallets[0].address, client);
  assert.deepEqual(s.checked, [client, provider]); assert.deepEqual(s.resolved, [client]); assert.ok(!JSON.stringify(body).includes('private-wallet-id'));
});
test('anonymous wallet choices are empty; rate limits refuse before ownership lookups', async () => {
  const anonymous = walletRoute({ anonymous: true }); assert.deepEqual((await (await anonymous.GET({})).json()).wallets, []);
  const limited = walletRoute({ limited: true }); assert.equal((await limited.GET({})).status, 429); assert.equal(limited.checked.length, 0);
});
test('old workspace structure, real lifecycle and honest protocol boundary are retained', () => {
  for (const text of ['Job Board', 'Post a Job', 'Manage Job', 'My Jobs', 'Select provider', 'Fund with FlareHQEscrow', 'Submit work', 'Approve submission', 'Accept release', 'Open dispute', 'Refund after expiry']) assert.ok(page.includes(text));
  assert.match(page, /className=\{`light/); assert.match(page, /No browser-wallet connection is needed/);
  assert.doesNotMatch(page, /isConnected|fetch\('\/api\/jobs/);
  assert.doesNotMatch(page, /not ERC-8183|does not import its jobs|FlareHQEscrow holds job funds/);
  assert.match(page, /Funds are held in escrow on-chain; FlareHQ never holds them\./);
  assert.match(page, /selectedId\.current/); assert.match(page, /encodeURIComponent\(viewer\)/);
  assert.match(page, /loadMine\(actorAddress\)/);
  assert.match(file('src/app/api/flarehq-jobs/route.ts'), /applications: \{ some: \{ applicantAddress/);
  const css = file('src/app/flarehq-jobs/jobs.module.css'); assert.match(css, /@media/); assert.match(css, /padding: 76px/);
});

function mineRoute(authorized = true) {
  const queries = [], module = { exports: {} };
  const stubs = {
    'next/server': { NextResponse: { json: (value, init) => new Response(JSON.stringify(value), init) } },
    '@/lib/prisma': { prisma: { flareHQJob: { findMany: async (query) => { queries.push(query); return []; } } } },
    '@/lib/escrow/escrowGuard': { escrowAddressOr503: () => ({ address: provider }) },
    '@/lib/escrow/escrowAmount': {},
    '@/lib/jobs/flarehqJobAuth': { requireFlareHQJobActor: async (_req, address) => authorized && same(address, client) ? { address: client } : null },
    '@/lib/jobs/flarehqJob': { serializeFlareHQJob: (job) => job },
  };
  const code = ts.transpileModule(file('src/app/api/flarehq-jobs/route.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)((name) => { if (!Object.hasOwn(stubs, name)) throw new Error('Unexpected dependency'); return stubs[name]; }, module, module.exports);
  return { ...module.exports, queries };
}
test('My Jobs handler includes owned applications only after actor authorization', async () => {
  const s = mineRoute(); const response = await s.GET(new Request(`https://example.test/api/flarehq-jobs?status=all&address=${client}&limit=100`));
  assert.equal(response.status, 200);
  assert.deepEqual(s.queries[0].where.OR[2], { applications: { some: { applicantAddress: { equals: client, mode: 'insensitive' } } } });
  assert.deepEqual(s.queries[0].include, { applications: { where: { applicantAddress: { equals: client, mode: 'insensitive' } } } });
  const denied = mineRoute(false);
  assert.equal((await denied.GET(new Request(`https://example.test/api/flarehq-jobs?address=${client}`))).status, 403);
  assert.equal(denied.queries.length, 0);
});
test('public board does not include application payloads', async () => {
  const s = mineRoute(); await s.GET(new Request('https://example.test/api/flarehq-jobs?status=all'));
  assert.deepEqual(s.queries[0].include, { applications: false }); assert.equal(s.queries[0].where.OR, undefined);
});
