// Current production modules with offline DB/SDK/RPC dependencies. No database
// connection, signing, broadcasting, wallet creation or funds are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './fixtures/load-typescript.mjs';
import { MAINNET_ENV, withEnv } from './fixtures/mainnet-env.mjs';
import { getArcNetworkName, getNetworkConfig } from '../src/lib/config/network.ts';
import { reserveBridgeIntent, BridgeIntentConflictError } from '../src/lib/bridge/intentReuse.ts';
import { withReadOnlyBridgeAdapter } from '../src/lib/bridge/readOnlyAdapter.ts';
import { extractBurnTxHash } from '../src/lib/bridge/resumeStore.ts';
import { pollBridgeSettlementStatus } from '../src/lib/bridge/settlementPolling.ts';
import {
  bridgeHasRecoveryEvidence, canRetryBridgeBeforeBurn, bridgeEventHash,
  bridgeResultFailure, selectBridgeRecoveryHash,
} from '../src/lib/bridge/resultState.ts';

const SOURCE = '0x' + 'a'.repeat(40);
const DEST = '0x' + 'b'.repeat(40);
const OTHER = '0x' + 'c'.repeat(40);
const BURN = '0x' + '1'.repeat(64);
const WRONG = '0x' + '2'.repeat(64);
const MINT = '0x' + '3'.repeat(64);
const NOW = new Date('2026-11-19T17:00:00Z');
const REQUEST = { sourceWallet: SOURCE, destination: DEST, sourceChain: 'Base', amount: '200000' };
const intentRow = (data = {}) => ({ id: 'same-intent', ...REQUEST, status: 'PENDING', burnTxHash: null,
  mintTxHash: null, cctpNonce: null, destinationBound: false, createdAt: new Date(NOW.getTime() - 1000),
  expiresAt: new Date(NOW.getTime() + 3600000), ...data });

function memoryDb(initial = []) {
  const rows = initial.map((row) => ({ ...row }));
  const locks = new Map();
  const calls = [];
  let sequence = 0;
  const matches = (row, where) => Object.entries(where).every(([key, value]) => value && typeof value === 'object' && 'equals' in value
    ? String(row[key]).toLowerCase() === String(value.equals).toLowerCase() : row[key] === value);
  const db = { flowBridgeIntent: {
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? { ...row } : null; },
    async findFirst({ where }) { const row = rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0]; return row ? { ...row } : null; },
    async create({ data }) { calls.push(['create', data]); const row = { ...intentRow(), ...data, id: `intent-${++sequence}` }; rows.push(row); return { ...row }; },
    async updateMany({ where, data }) { calls.push(['updateMany', { where, data }]); const selected = rows.filter((r) => matches(r, where));
      for (const row of selected) Object.assign(row, data); return { count: selected.length }; },
  }, async $transaction(fn) {
    let unlock;
    const tx = { flowBridgeIntent: db.flowBridgeIntent, async $executeRawUnsafe(sql, key) {
      calls.push(['lock', { sql, key }]); const previous = locks.get(key) ?? Promise.resolve();
      const acquired = new Promise((resolve) => { unlock = resolve; }); locks.set(key, acquired);
      await previous;
    } };
    try { return await fn(tx); } finally { unlock?.(); }
  } };
  return { db, rows, calls };
}

test('20 concurrent duplicate opens reserve exactly one intent under the advisory lock', async () => {
  const f = memoryDb();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveBridgeIntent(f.db,
    { ...REQUEST, sourceWallet: i % 2 ? SOURCE.toUpperCase() : SOURCE, destination: i % 3 ? DEST : DEST.toUpperCase() }, NOW)));
  assert.equal(new Set(results.map(({ intent }) => intent.id)).size, 1);
  assert.equal(results.filter(({ reused }) => !reused).length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
  assert.equal(new Set(f.calls.filter(([name]) => name === 'lock').map(([, { key }]) => key)).size, 1);
  assert.ok(f.calls.filter(([name]) => name === 'lock').every(([, { sql }]) => sql === 'SELECT pg_advisory_xact_lock(hashtext($1))'));
});

test('expired pending intent remains the same reference, not an automatic fresh burn', async () => {
  const row = intentRow({ expiresAt: new Date(NOW.getTime() - 1) }); const f = memoryDb([row]);
  const { intent, reused } = await reserveBridgeIntent(f.db, REQUEST, NOW);
  assert.equal(intent.id, row.id); assert.equal(reused, true); assert.equal(+intent.expiresAt, +row.expiresAt);
  assert.equal(f.calls.filter(([name]) => name !== 'lock').length, 0);
});
test('already-funded intent wins over a newer pending duplicate even after expiry', async () => {
  const funded = intentRow({ status: 'BURN_CONFIRMED', burnTxHash: BURN, expiresAt: new Date(NOW.getTime() - 1) });
  const f = memoryDb([funded, intentRow({ id: 'newer', createdAt: NOW })]);
  const { intent } = await reserveBridgeIntent(f.db, REQUEST, NOW);
  assert.equal(intent.id, funded.id); assert.equal(intent.burnTxHash, BURN); assert.equal(f.rows.length, 2);
});

for (const difference of [{ sourceWallet: OTHER }, { destination: OTHER }, { sourceChain: 'Ethereum' }, { amount: '500000' }, { reference: 'missing' }]) {
  test(`explicit reference cannot substitute ${Object.keys(difference)[0]}`, async () => {
    const f = memoryDb([intentRow()]);
    await assert.rejects(reserveBridgeIntent(f.db, { ...REQUEST, reference: 'same-intent', ...difference }, NOW), BridgeIntentConflictError);
    assert.ok(f.calls.every(([name]) => name === 'lock'));
  });
}

test('only explicit same-reference pre-burn confirmation renews submission TTL', async () => {
  const row = intentRow({ expiresAt: new Date(NOW.getTime() - 1) }); const f = memoryDb([row]);
  await reserveBridgeIntent(f.db, { ...REQUEST, renewSubmission: true }, NOW);
  assert.equal(+f.rows[0].expiresAt, +row.expiresAt, 'renew without reference is not permission');
  await reserveBridgeIntent(f.db, { ...REQUEST, reference: row.id }, NOW);
  assert.equal(+f.rows[0].expiresAt, +row.expiresAt, 'same reference without confirmation is not permission');
  const { intent } = await reserveBridgeIntent(f.db, { ...REQUEST, reference: row.id, renewSubmission: true }, NOW);
  assert.equal(+intent.expiresAt, +NOW + 7200000); assert.equal(intent.id, row.id); assert.equal(f.rows.length, 1);
  assert.deepEqual(f.calls.find(([name]) => name === 'updateMany')[1].where, { id: row.id, status: 'PENDING', burnTxHash: null });
});
for (const data of [{ status: 'BURN_CONFIRMED', burnTxHash: BURN }, { burnTxHash: BURN }, { status: 'COMPLETED', burnTxHash: BURN, mintTxHash: MINT }, { status: 'FAILED' }]) {
  test(`explicit retry never renews funded/terminal intent ${JSON.stringify(data)}`, async () => {
    const row = intentRow({ ...data, expiresAt: new Date(NOW.getTime() - 1) }); const f = memoryDb([row]);
    const { intent } = await reserveBridgeIntent(f.db, { ...REQUEST, reference: row.id, renewSubmission: true }, NOW);
    assert.equal(intent.id, row.id); assert.equal(+intent.expiresAt, +row.expiresAt); assert.equal(f.rows.length, 1);
    assert.ok(f.calls.every(([name]) => name === 'lock'));
  });
}
test('lost conditional renewal refuses instead of silently authorizing signing', async () => {
  const f = memoryDb([intentRow({ expiresAt: new Date(NOW.getTime() - 1) })]);
  f.db.flowBridgeIntent.updateMany = async () => ({ count: 0 });
  await assert.rejects(reserveBridgeIntent(f.db, { ...REQUEST, reference: 'same-intent', renewSubmission: true }, NOW), BridgeIntentConflictError);
});

for (const saved of [
  { burnTxHash: BURN }, { mintTxHash: MINT }, { result: { steps: [{ name: 'burn', txHash: BURN, state: 'pending' }] } },
  { result: { steps: [{ name: 'depositForBurn', txHash: BURN, state: 'error' }] } },
  { result: { steps: [{ name: 'burn', state: 'success' }] } }, { result: { steps: [{ name: 'mint', state: 'success' }] } },
]) {
  test('any observed burn/mint excludes a second source spend, even if reviewed', () => {
    assert.equal(bridgeHasRecoveryEvidence(saved), true); assert.equal(canRetryBridgeBeforeBurn(saved, true), false);
  });
}
test('ambiguous pre-burn retry requires explicit review; pre-sign failure can retry same intent', () => {
  for (const signingStarted of [undefined, true]) {
    assert.equal(canRetryBridgeBeforeBurn({ signingStarted }, false), false);
    assert.equal(canRetryBridgeBeforeBurn({ signingStarted }, true), true);
  }
  assert.equal(canRetryBridgeBeforeBurn({ signingStarted: false }, false), true);
});
test('SDK event hashes distinguish approval, burn and mint; malformed/foreign events cannot save hashes', () => {
  assert.equal(bridgeEventHash({ method: 'approve', values: { txHash: WRONG } }, 'burn'), null);
  assert.equal(bridgeEventHash({ method: 'burn', values: { txHash: BURN } }, 'burn'), BURN);
  assert.equal(bridgeEventHash({ method: 'depositForBurn', values: { txHash: BURN } }, 'burn'), BURN);
  assert.equal(bridgeEventHash({ method: 'mint', values: { txHash: MINT } }, 'mint'), MINT);
  assert.equal(bridgeEventHash({ method: 'burn', values: { txHash: '0xwrong' } }, 'burn'), null);
  assert.equal(bridgeEventHash({ method: 'mint', values: { txHash: MINT } }, 'burn'), null);
});
test('recovery uses authoritative hashes first, but an unbound typo is replaceable', () => {
  assert.equal(selectBridgeRecoveryHash(BURN, WRONG, WRONG), BURN);
  assert.equal(selectBridgeRecoveryHash(null, ` ${BURN} `, WRONG), BURN);
  assert.equal(selectBridgeRecoveryHash(undefined, '', BURN), BURN);
});
test('SDK allowance error is not mislabeled as balance or gas failure', () => {
  assert.match(bridgeResultFailure({ state: 'error', steps: [{ name: 'burn', state: 'error', error: { message: 'ERC20: transfer amount exceeds allowance' } }] }, 'Base'), /did not allow enough USDC/);
  assert.match(bridgeResultFailure({ state: 'error', steps: [{ name: 'approve', state: 'success', txHash: WRONG }] }, 'Base'), /did not return a transaction hash/);
  assert.match(bridgeResultFailure({ steps: [{ name: 'burn', state: 'pending', txHash: BURN }] }, 'Base'), /instead of starting another one/);
});

function verifyFixture(row) {
  const f = memoryDb([row]); let proof = { ok: false, reason: 'NOT_FOUND' }; let owner = true; const stages = [];
  f.db.consumerAccount = { async findUnique() { return { walletType: 'EXTERNAL', walletAddress: SOURCE }; } };
  const module = loadTypescript('src/app/api/cctp/transfer/external/verify/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/src/lib/middleware/withConsumerAuth': { resolveConsumerSession: async () => SOURCE },
    '@/src/lib/prisma': { prisma: f.db }, '@/src/lib/auth/consumerWallet': { resolveConsumerWallet: () => ({ mode: 'EXTERNAL' }) },
    '@/src/lib/ratelimit': { checkRateLimit: async () => ({ allowed: true }) },
    '@/lib/bridge/sourceChains': { findBridgeSourceChain: () => ({ chain: { id: 'Base', label: 'Base', chainId: 8453 }, network: 'mainnet' }), sourceExplorerTxUrl: (_id, hash) => `https://source.example/tx/${hash}` },
    '@/lib/bridge/externalDestination': { resolveExternalBridgeDestination: async () => ({ ok: true, destination: DEST }) },
    '@/lib/bridge/externalVerify': { verifyExternalBurn: async () => proof },
    '@/lib/bridge/irisNonce': { EMPTY_MESSAGE_NONCE: '0x' + '0'.repeat(64) },
    '@/lib/bridge/stageLogger': { logBridgeStage: async (_id, stage) => { stages.push(stage); } },
    '@/lib/wallet/verifyCallerControlsAddress': { verifyCallerControlsAddress: async () => owner ? {} : null },
  }, { console: { log() {}, error() {} } });
  return { ...f, stages, changeProof: (next) => { proof = next; }, deny: () => { owner = false; },
    verify: (hash) => module.POST(new Request('https://app.example/api/cctp/transfer/external/verify', { method: 'POST', body: JSON.stringify({ reference: row.id, burnTxHash: hash }) })) };
}
for (const reason of ['NOT_FOUND', 'NOT_MINED', 'REVERTED', 'WRONG_SENDER', 'AMOUNT_MISMATCH', 'BINDING_MISMATCH', 'RPC_UNAVAILABLE']) {
  for (const expired of [false, true]) test(`candidate ${reason} (${expired ? 'expired' : 'live'} intent) leaves real-burn recovery open`, async () => {
    const row = intentRow({ expiresAt: new Date(Date.now() + (expired ? -1000 : 100000)) }); const f = verifyFixture(row);
    f.changeProof({ ok: false, reason }); const response = await f.verify(WRONG); const body = await response.json();
    assert.equal(response.status, 422); assert.equal(body.recoverable, true); assert.equal(f.rows[0].status, 'PENDING');
    assert.equal(f.rows[0].burnTxHash, null); assert.equal(f.rows[0].mintTxHash, null); assert.ok(f.calls.every(([name]) => name !== 'updateMany'));
    assert.equal(f.stages.at(-1).metadata.candidateOnly, true);
    f.changeProof({ ok: true, burnTxHash: BURN, destinationBound: true, cctpNonce: 'attested-nonce' });
    const corrected = await f.verify(BURN); assert.equal(corrected.status, 200); assert.equal(f.rows[0].status, 'BURN_CONFIRMED'); assert.equal(f.rows[0].burnTxHash, BURN);
  });
}
test('bound burn refuses a replacement and the ownership gate refuses before proof/state changes', async () => {
  const f = verifyFixture(intentRow({ status: 'BURN_CONFIRMED', burnTxHash: BURN }));
  assert.equal((await f.verify(WRONG)).status, 409); assert.equal(f.rows[0].burnTxHash, BURN);
  f.deny(); assert.equal((await f.verify(BURN)).status, 403); assert.equal(f.stages.length, 0); assert.equal(f.calls.length, 0);
});

const signingEdges = ['prepare', 'prepareAction', 'executeAction', 'sendTransaction', 'signTypedData', 'batchExecute', 'getSdk', 'initializeWalletClient'];
for (const edge of signingEdges) test(`read-only source adapter denies ${edge}`, async () => {
  let signs = 0; const adapter = withReadOnlyBridgeAdapter({ async [edge]() { signs++; } });
  await assert.rejects(adapter[edge]({}), (error) => error.code === 'BRIDGE_RECOVERY_READ_ONLY'); assert.equal(signs, 0);
});
test('source recovery permits receipt polling but guarded delegation cannot sign', async () => {
  let signs = 0; const inner = { async sendTransaction() { signs++; }, async waitForTransaction() { return 'receipt'; } };
  const adapter = withReadOnlyBridgeAdapter({ async resolveAdapter() { return inner; }, async waitForTransaction(...args) { return (await this.resolveAdapter()).waitForTransaction(...args); } });
  assert.equal(await adapter.waitForTransaction(BURN), 'receipt');
  await assert.rejects((await adapter.resolveAdapter()).sendTransaction({}), /cannot submit/); assert.equal(signs, 0);
});

async function serverStatusFixture(result, network, retry) {
  return withEnv({ ...(network === 'mainnet' ? MAINNET_ENV : { ARC_NETWORK: 'testnet' }),
    CIRCLE_API_KEY: 'offline', CIRCLE_ENTITY_SECRET: 'offline', CCTP_MAINNET_SOURCES_JSON: JSON.stringify([{ id: 'Base', label: 'Base', circleBlockchain: 'ARC' }]), CCTP_MAINNET_ARC_CHAIN_ID: 'Arc',
  }, async () => {
    class OfflineKit { async bridge() { return result; } async retry(previous, context) { return retry(previous, context); } }
    let signs = 0;
    const adapter = { async prepare() { signs++; }, async sendTransaction() { signs++; }, async waitForTransaction() { return 'receipt'; } };
    const cctp = loadTypescript('src/lib/cctp-v2.ts', {
      '@circle-fin/bridge-kit': { BridgeKit: OfflineKit, BridgeChain: { Arc: 'Arc', Arc_Testnet: 'Arc_Testnet', Base: 'Base' } },
      '@circle-fin/adapter-circle-wallets': { createCircleWalletsAdapter: () => adapter },
      '@/lib/config/network': { getArcNetworkName, getNetworkConfig },
      '@/lib/bridge/sourceChains': { getBridgeSourceChains: () => [{ id: 'Base', label: 'Base', circleBlockchain: 'BASE-SEPOLIA' }] },
      '@/lib/bridge/cctpAvailability': { CctpUnavailableError: class extends Error {} },
      '@/lib/circle/client': { getCircleClient: () => ({}) },
      '@/lib/circle/networkGuard': { withCircleBridgeAdapterGuard: (value) => value },
      '@/lib/bridge/resumeStore': { extractBurnTxHash }, '@/lib/bridge/readOnlyAdapter': { withReadOnlyBridgeAdapter },
    }, { console: { log() {}, error() {} } });
    const { reference } = cctp.startBridge({ fromChain: 'Base', toChain: network === 'mainnet' ? 'Arc' : 'Arc_Testnet', amount: '0.2', senderAddress: SOURCE, recipientAddress: DEST });
    // Flush the deterministic mock bridge promise; no timers or real network.
    await Promise.resolve();
    const status = await cctp.checkBridgeStatus(reference); return { status, signs };
  });
}
test('server mainnet bridge refuses before SDK execution; pending testnet approval never invokes retry', async () => {
  let retries = 0; const retry = async (r) => { retries++; return r; };
  await assert.rejects(serverStatusFixture({ state: 'pending', steps: [{ name: 'burn', txHash: BURN }] }, 'mainnet', retry), /cannot initialize Arc Mainnet/);
  await serverStatusFixture({ state: 'pending', steps: [{ name: 'approve', txHash: WRONG }] }, 'testnet', retry);
  assert.equal(retries, 0);
});
test('legacy testnet status recovery can poll/mint but cannot reopen source approval or burn', async () => {
  const { signs, status } = await serverStatusFixture({ state: 'pending', steps: [{ name: 'burn', txHash: BURN }] }, 'testnet', async (r, context) => {
    assert.equal(await context.from.waitForTransaction(BURN), 'receipt');
    await assert.rejects(context.from.prepare({}), /cannot submit/);
    await assert.rejects(context.from.sendTransaction({}), /cannot submit/);
    assert.notEqual(context.from, context.to); return { ...r, state: 'success' };
  });
  assert.equal(signs, 0); assert.equal(status.result.state, 'success');
});

test('current-session settlement polling discovers the relay mint without signing dependencies', async () => {
  const responses = [
    { success: true, state: 'burn-confirmed', burnTxHash: BURN },
    { success: true, state: 'burn-confirmed', burnTxHash: BURN, relayMintTxHash: MINT },
  ];
  const calls = []; let waits = 0;
  const result = await pollBridgeSettlementStatus({
    reference: 'same-intent', rounds: 3, delayMs: 1,
    fetchStatus: async (reference) => { calls.push(reference); return responses.shift(); },
    wait: async () => { waits++; },
  });
  assert.deepEqual(result, { burnTxHash: BURN, mintTxHash: MINT });
  assert.deepEqual(calls, ['same-intent', 'same-intent']); assert.equal(waits, 1);
});

test('rehydrated settlement polling prefers server-bound hashes and never accepts malformed candidates', async () => {
  const result = await pollBridgeSettlementStatus({
    reference: 'rehydrated-intent', rounds: 1, delayMs: 0,
    fetchStatus: async () => ({ success: true, state: 'completed', burnTxHash: BURN, mintTxHash: '0xwrong', relayMintTxHash: MINT }),
  });
  assert.deepEqual(result, { burnTxHash: BURN, mintTxHash: MINT });
});

test('read-only settlement polling surfaces terminal status and interruption without retry loops', async () => {
  let calls = 0; let waits = 0;
  await assert.rejects(pollBridgeSettlementStatus({
    reference: 'failed-intent', rounds: 5, delayMs: 1,
    fetchStatus: async () => { calls++; return { success: true, state: 'failed', error: 'recover manually' }; },
    wait: async () => { waits++; },
  }), (error) => error.bridgeCopy === true && error.message === 'recover manually');
  assert.equal(calls, 1); assert.equal(waits, 0);
  await assert.rejects(pollBridgeSettlementStatus({
    reference: 'closed-tab', rounds: 5, delayMs: 1,
    fetchStatus: async () => { throw new Error('must not run'); }, isActive: () => false,
  }), /Bridge interrupted/);
});
