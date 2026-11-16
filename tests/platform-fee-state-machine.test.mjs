// Actual production fee engine, in-memory stores/ports only. No DB fixtures,
// credentials, RPC, Circle calls, or funds. Run with:
// npx tsx --test tests/platform-fee-state-machine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.ts';
import {
  FEE_STALE_MS,
  feeIdempotencyKey,
  isFeeTransientError,
  isTerminalCircleError,
  prismaPlatformFeeStore,
  settlePlatformFeeOnce,
} from '../src/lib/payments/platformFee.ts';

const NOW = Date.UTC(2026, 10, 16);
const COLLECT = Object.freeze({
  kind: 'collect', walletId: 'offline-wallet', walletAddress: '0x' + 'a'.repeat(40),
  destinationAddress: '0x' + 'b'.repeat(40), amountStr: '0.000025',
  tokenAddress: '0x' + 'c'.repeat(40), decimals: 6,
});
const copy = (row) => row ? { ...row, createdAt: new Date(row.createdAt) } : null;

function memoryStore(seed) {
  const rows = new Map(seed ? [[seed.paymentLogId, copy(seed)]] : []);
  const writes = [];
  const byId = (id) => {
    const row = [...rows.values()].find((r) => r.id === id);
    assert.ok(row, `unknown fixture row ${id}`);
    return row;
  };
  const insert = (data, status) => {
    if (rows.has(data.paymentLogId)) throw Object.assign(new Error('unique payment'), { code: 'P2002' });
    const row = { id: `fee-${data.paymentLogId}`, amountReceived: null, txHash: null,
      deferredReason: null, circleTxId: null, idempotencyKey: null,
      createdAt: new Date(NOW), ...data, status };
    rows.set(row.paymentLogId, row);
    writes.push(status);
    return copy(row);
  };
  const store = {
    rows, writes,
    findByPayment: async (id) => copy(rows.get(id)),
    createPending: async (data) => insert(data, 'PENDING'),
    createDeferred: async (data) => insert(data, 'DEFERRED'),
    setCircleTxId: async (id, circleTxId) => { byId(id).circleTxId = circleTxId; writes.push('anchor'); },
    markSuccess: async (id, data) => {
      Object.assign(byId(id), data, { status: 'SUCCESS' }); writes.push('SUCCESS'); return copy(byId(id));
    },
    markFailedTerminal: async (id, reason) => {
      Object.assign(byId(id), { status: 'FAILED', circleTxId: null, deferredReason: reason }); writes.push('FAILED');
    },
    markUnknown: async (id) => { byId(id).status = 'PENDING'; writes.push('unknown'); },
    // Unique insertion is atomic; exercising P2002 is intentional here.
    serialize: async (_id, fn) => fn(store),
  };
  return store;
}

function fixtureRow(overrides = {}) {
  return { id: 'fee-offline', paymentLogId: 'offline', merchantId: 'merchant-offline',
    amountCharged: 0.000025, amountReceived: null, status: 'PENDING', txHash: null,
    deferredReason: null, circleTxId: null, idempotencyKey: feeIdempotencyKey('offline'),
    createdAt: new Date(NOW), ...overrides };
}

function harness(t, seed, portOverrides = {}) {
  // Fail loudly even if a regression accidentally reaches real adapters.
  const forbidden = () => { throw new Error('Live effects forbidden in fee unit tests'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  // Prisma exposes methods through a proxy; replace/restore explicitly.
  const transaction = prisma.$transaction;
  prisma.$transaction = forbidden;
  t.after(() => { prisma.$transaction = transaction; });
  for (const method of ['findUnique', 'create', 'update']) {
    const original = prisma.platformFee[method];
    prisma.platformFee[method] = forbidden;
    t.after(() => { prisma.platformFee[method] = original; });
  }
  const store = memoryStore(seed);
  const creates = [], polls = [];
  const ports = {
    createTransfer: async (args) => {
      creates.push(args);
      assert.ok(store.rows.size === 1, 'claim must precede transfer');
      return { circleTxId: `offline-circle-${creates.length}` };
    },
    pollTransfer: async (id) => {
      polls.push(id);
      assert.ok([...store.rows.values()].some((r) => r.circleTxId === id), 'anchor must precede poll');
      return '0x' + 'd'.repeat(64);
    },
    ...portOverrides,
  };
  const run = (overrides = {}) => settlePlatformFeeOnce({
    store, ports, paymentLogId: 'offline', merchantId: 'merchant-offline',
    amountCharged: 0.000025, decision: COLLECT, now: () => NOW, ...overrides,
  });
  return { store, ports, creates, polls, run };
}

test('0.01 USDC at 25bps rounds to 25 micro-USDC, not zero', () => {
  const route = readFileSync(new URL('../src/app/api/payments/verify-onchain/route.ts', import.meta.url), 'utf8');
  assert.match(route, /PLATFORM_FEE_BPS/);
  assert.match(route, /fee collector address not configured/);
  assert.equal(Math.round((0.01 * 25 / 10_000) * 1_000_000), 25);
  // This proves arithmetic only, NOT the original production deferral reason.
});

test('collect claims and anchors before polling, with exact server-decided parameters', async (t) => {
  const h = harness(t);
  const result = await h.run();
  assert.equal(result.action, 'collected');
  assert.equal(result.row.status, 'SUCCESS');
  assert.deepEqual(h.store.writes, ['PENDING', 'anchor', 'SUCCESS']);
  assert.deepEqual(h.creates[0], { walletId: COLLECT.walletId, walletAddress: COLLECT.walletAddress,
    destinationAddress: COLLECT.destinationAddress, amount: COLLECT.amountStr,
    tokenAddress: COLLECT.tokenAddress, decimals: 6, idempotencyKey: feeIdempotencyKey('offline') });
});

test('ten fresh concurrent claimants create one transfer and one fee row', async (t) => {
  const h = harness(t);
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => h.run()));
  assert.equal(outcomes.length, 10);
  assert.equal(h.creates.length, 1);
  assert.equal(h.store.rows.size, 1);
  assert.equal(h.store.rows.get('offline').status, 'SUCCESS');
});

test('successful replay skips without transferring, polling, or mutating', async (t) => {
  const row = fixtureRow({ status: 'SUCCESS', txHash: '0x' + 'd'.repeat(64) });
  const h = harness(t, row);
  const result = await h.run();
  assert.equal(result.action, 'skipped'); assert.equal(result.reason, 'already-collected');
  assert.deepEqual(h.creates, []); assert.deepEqual(h.polls, []); assert.deepEqual(h.store.writes, []);
});

for (const reason of ['non-Circle wallet, cannot auto-debit', 'fee rounds to zero',
  'fee collector address not configured', 'insufficient balance']) {
  test(`defer persists caller-supplied reason: ${reason}`, async (t) => {
    const h = harness(t);
    const result = await h.run({ decision: { kind: 'defer', reason } });
    assert.equal(result.action, 'deferred'); assert.equal(result.row.deferredReason, reason);
    assert.equal(result.row.status, 'DEFERRED'); assert.equal(result.row.txHash, null);
    assert.deepEqual(h.creates, []); assert.deepEqual(h.polls, []);
    // A changed collect decision cannot silently collect an existing deferral.
    const replay = await h.run();
    assert.equal(replay.action, 'skipped'); assert.equal(replay.reason, 'already-deferred');
    assert.equal(replay.row.deferredReason, reason); assert.deepEqual(h.creates, []);
  });
}

test('fresh pending row without an anchor fails closed as in-progress', async (t) => {
  const h = harness(t, fixtureRow());
  const result = await h.run();
  assert.equal(result.reason, 'in-progress'); assert.deepEqual(h.creates, []);
});

test('serial stale-claim retry uses the existing fee row and stable key', async (t) => {
  const h = harness(t, fixtureRow({ createdAt: new Date(NOW - FEE_STALE_MS) }));
  assert.equal((await h.run()).action, 'collected');
  assert.equal(h.creates.length, 1); assert.equal(h.store.rows.size, 1);
  assert.equal(h.creates[0].idempotencyKey, feeIdempotencyKey('offline'));
});

test('defer decision does not execute an already-claimed stale pending row', async (t) => {
  const h = harness(t, fixtureRow({ createdAt: new Date(NOW - FEE_STALE_MS) }));
  const result = await h.run({ decision: { kind: 'defer', reason: 'insufficient balance' } });
  assert.equal(result.reason, 'already-claimed-pending'); assert.deepEqual(h.creates, []);
});

for (const status of ['PENDING', 'FAILED', 'SETTLEMENT_ERROR']) {
  test(`tracked ${status} resumes the same transfer without creating`, async (t) => {
    const h = harness(t, fixtureRow({ status, circleTxId: 'offline-tracked' }));
    assert.equal((await h.run()).action, 'resumed');
    assert.deepEqual(h.creates, []); assert.deepEqual(h.polls, ['offline-tracked']);
  });
}

test('unknown finality retains the anchor; later retry polls instead of transferring', async (t) => {
  const h = harness(t);
  const realPoll = h.ports.pollTransfer;
  h.ports.pollTransfer = async () => { throw new Error('offline timeout'); };
  const first = await h.run();
  assert.match(first.reason, /^unknown-finality:/);
  assert.equal(first.row.status, 'PENDING'); assert.ok(first.row.circleTxId);
  h.ports.pollTransfer = realPoll;
  assert.equal((await h.run()).action, 'resumed'); assert.equal(h.creates.length, 1);
});

test('terminal failure clears anchor and a serial retry reuses the idempotency key', async (t) => {
  const h = harness(t);
  const realPoll = h.ports.pollTransfer;
  h.ports.pollTransfer = async () => { throw new Error('Circle tx failed: offline fixture'); };
  const first = await h.run();
  assert.equal(first.action, 'failed'); assert.equal(first.row.status, 'FAILED');
  assert.equal(first.row.circleTxId, null);
  h.ports.pollTransfer = realPoll;
  assert.equal((await h.run()).action, 'collected');
  assert.equal(h.creates.length, 2); assert.equal(h.creates[0].idempotencyKey, h.creates[1].idempotencyKey);
});

test('transfer initialization failure returns a failed fee outcome', async (t) => {
  const h = harness(t, undefined, {
    createTransfer: async () => { throw new Error('Both native and fallback initialization failed: offline'); },
  });
  const result = await h.run();
  assert.equal(result.action, 'failed'); assert.equal(result.row.circleTxId, null);
  assert.equal(result.row.status, 'FAILED');
});

for (const measurement of [0.000024, null, 'throws']) {
  test(`receipt measurement ${measurement} does not reverse fee success`, async (t) => {
    const h = harness(t, undefined, { measureReceived: async () => {
      if (measurement === 'throws') throw new Error('offline measurement failed');
      return measurement;
    } });
    const result = await h.run();
    assert.equal(result.action, 'collected');
    assert.equal(result.row.amountReceived, typeof measurement === 'number' ? measurement : 0.000025);
  });
}

test('unexpected untracked state skips without creating', async (t) => {
  const h = harness(t, fixtureRow({ status: 'UNEXPECTED' }));
  assert.equal((await h.run()).reason, 'unexpected-fee-state:UNEXPECTED');
  assert.deepEqual(h.creates, []);
});

test('transient DB error classification stays separate from Circle finality', () => {
  for (const code of ['P2028', 'P2034']) assert.equal(isFeeTransientError({ code }), true);
  for (const e of [null, {}, { code: 'P2002' }]) assert.equal(isFeeTransientError(e), false);
  assert.equal(isTerminalCircleError(new Error('Circle tx failed: fixture')), true);
  assert.equal(isTerminalCircleError(new Error('offline timeout')), false);
});

test('Prisma adapter claim uses the transaction-bound delegate and advisory lock', async (t) => {
  harness(t); // Block the actual client, even though the adapter receives a fake.
  const events = [];
  const row = fixtureRow();
  const inner = {
    $executeRawUnsafe: async (sql, key) => { events.push(['lock', sql, key]); },
    platformFee: {
      findUnique: async () => { events.push(['find']); return null; },
      create: async ({ data }) => { events.push(['create', data]); return { ...row, ...data }; },
    },
  };
  const db = { platformFee: {}, $transaction: async (fn) => { events.push(['transaction']); return fn(inner); } };
  const store = prismaPlatformFeeStore(db);
  await store.serialize('offline', async (scoped) => {
    assert.equal(await scoped.findByPayment('offline'), null);
    await scoped.createPending({ paymentLogId: 'offline', merchantId: 'merchant-offline',
      amountCharged: 0.000025, idempotencyKey: feeIdempotencyKey('offline') });
  });
  assert.deepEqual(events.map((e) => e[0]), ['transaction', 'lock', 'find', 'create']);
  assert.match(events[1][1], /pg_advisory_xact_lock/);
  assert.equal(events[1][2], 'swap-tx-claim:platform-fee:offline');
});

test('fee engine has no PaymentLog write authority', () => {
  const source = readFileSync(new URL('../src/lib/payments/platformFee.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:prisma|db)\.paymentLog/);
});
