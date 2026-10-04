/**
 * payment-hardening-tests.ts
 *
 * Production-hardening regression suite (H1 + fee exactly-once + arcTestnet +
 * Mainnet USDC-only). Live Neon DB for state assertions (throwaway HARDEN-
 * rows, cleaned up afterwards); NO chain transactions, NO fund movement, NO
 * mainnet RPC writes — on-chain evidence is synthetic, Circle is faked.
 *
 *   H1  A. same proof -> same invoice sequential replay (idempotent)
 *       B. same proof -> different invoice (409, second stays PENDING)
 *       C. unrelated transfer cannot pay an unrelated invoice (pure matcher)
 *       D. concurrent one-proof -> many invoices (exactly one winner)
 *       E. concurrent same-invoice same-proof (all succeed, one row)
 *       F. failed verification never poisons the proof claim (+ rollback)
 *       G. routed/CCTP behavior intact (static + pure-matrix spot checks)
 *   FEE 1. concurrent fee settlement -> exactly ONE transfer initiated
 *       2. crash after circleTxId anchor -> retry resumes, no second transfer
 *       3. terminal failure -> retry reuses the SAME idempotency key
 *       4. fee failure never throws (payment result unaffected)
 *       5. in-progress PENDING claim -> duplicates skip without transferring
 *       6. prisma store: concurrent claims -> one PENDING row (final DB state)
 *   NET - verifier uses authoritative chain config, never stale arcTestnet
 *       - getArcChain().id === getNetworkConfig().chainId (testnet + mainnet)
 *   USDC - mainnet EURC settlement refused server-side (pure gate)
 *       - attacker EURC verify-onchain call rejected pre-RPC (live route)
 *       - mainnet USDC passes the gate (route reaches chain, no state change)
 *
 * Run: npx tsx scripts/payment-hardening-tests.ts
 */

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';
import { encodeEventTopics, encodeAbiParameters, parseUnits } from 'viem';
import { erc20TransferAbi } from '@/src/lib/wallet/erc20';
import {
  findDirectTransfer,
  assertTransferNotPredatingInvoice,
  assertMainnetSettlementAllowed,
  settleDirectPaymentAtomic,
} from '@/src/lib/payments/directProof';
import {
  settlePlatformFeeOnce,
  prismaPlatformFeeStore,
  feeIdempotencyKey,
  type FeeStore,
  type FeeRow,
  type FeeTransferPorts,
} from '@/src/lib/payments/platformFee';
import {
  getNetworkConfig,
  getArcChain,
  __resetNetworkConfigCacheForTests,
} from '@/src/lib/config/network';
import { readFileSync } from 'fs';

/**
 * Burst-concurrency convergence: the pooled DB rejects some transaction
 * STARTS under burst (P2028/P2034 or mapped 503 — nothing started, nothing
 * changed). Those are safely retryable; retry them until every attempt has a
 * terminal outcome, then assert terminal invariants on final DB state.
 */
function isTransientOutcome(reason: any): boolean {
  return reason?.code === 'P2028' || reason?.code === 'P2034' || reason?.status === 503;
}

async function converge<T>(n: number, run: () => Promise<T>, retries = 4): Promise<T[]> {
  const settled: T[] = [];
  let attempts: Array<() => Promise<T>> = Array.from({ length: n }, () => run);
  for (let i = 0; attempts.length > 0 && i <= retries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
    const results = await Promise.allSettled(attempts.map((fn) => fn()));
    attempts = [];
    for (const r of results) {
      if (r.status === 'fulfilled') settled.push(r.value);
      else if (isTransientOutcome(r.reason) && i < retries) attempts.push(run);
      else (settled as any).push({ __rejected: r.reason });
    }
  }
  return settled;
}

/**
 * n parallel workers, each retrying ITS OWN attempt sequentially on transient
 * pool timeouts. Terminal outcome per worker: exactly one settled value or
 * one terminal rejection — no cross-worker mixing, so counts stay exact.
 */
async function raceEach<T>(n: number, run: (worker: number) => Promise<T>, retries = 8): Promise<T[]> {
  const workers = Array.from({ length: n }, (_, k) => (async () => {
    let last: any = null;
    for (let a = 0; a <= retries; a++) {
      if (a > 0) await new Promise((r) => setTimeout(r, 500 * a));
      try {
        return { __value: await run(k) } as any;
      } catch (e) {
        if (isTransientOutcome(e) && a < retries) { last = e; continue; }
        return { __rejected: e } as any;
      }
    }
    return { __rejected: last } as any;
  })());
  return Promise.all(workers) as any;
}

function rejectionsOf<T>(settled: T[]): any[] {
  return (settled as any[]).filter((s) => s && typeof s === 'object' && '__rejected' in s).map((s) => s.__rejected);
}

function valuesOf<T>(settled: T[]): T[] {
  return (settled as any[])
    .filter((s) => !(s && typeof s === 'object' && '__rejected' in s))
    .map((s) => (s && typeof s === 'object' && '__value' in s ? (s as any).__value : s));
}

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
const read = (p: string) => readFileSync(p, 'utf8');

const TS = Date.now().toString(36);
const REF = (n: string) => `HARDEN-${TS}-${n}`;
import { randomBytes } from 'crypto';
// Run-unique proof hashes: a crashed run's leaked claim must never collide
// with a later run's assertions (same invariant as production — distinct
// proofs are independent).
const TX = `0x${randomBytes(32).toString('hex')}`;
const TX2 = `0x${randomBytes(32).toString('hex')}`;
const MERCHANT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const USDC_TN = '0x3600000000000000000000000000000000000000';
const EURC_TN = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const CHAIN_TESTNET = 5042002;

async function mkPayment(reference: string, over: Record<string, any> = {}) {
  return prisma.paymentLog.create({
    data: {
      reference,
      amount: 1.0,
      currency: 'USDC',
      tokenAddress: USDC_TN,
      chain: 'Arc Testnet v1.0',
      senderEmail: 'pending@checkout',
      merchant: 'Hardening Test Merchant',
      merchantSCA: MERCHANT,
      status: 'PENDING',
      ...over,
    },
  });
}

async function cleanup(refs: string[]) {
  for (const reference of refs) {
    const row = await prisma.paymentLog.findUnique({ where: { reference } }).catch(() => null);
    if (!row) continue;
    await (prisma as any).directPaymentProof.deleteMany({ where: { paymentLogId: row.id } }).catch(() => null);
    await (prisma as any).platformFee.deleteMany({ where: { paymentLogId: row.id } }).catch(() => null);
    await prisma.paymentLog.delete({ where: { reference } }).catch(() => null);
  }
}

function transferLog(to: string, value: bigint, token: string, logIndex: number) {
  const topics = encodeEventTopics({
    abi: erc20TransferAbi,
    eventName: 'Transfer',
    args: { from: OTHER as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [value]);
  return { address: token, data, topics, logIndex };
}

// ─── Fake fee store (Map-backed, P2002 on dup — mirrors the DB constraint) ──
function fakeFeeStore(): FeeStore & { rows: Map<string, FeeRow>; creates: number } {
  const rows = new Map<string, FeeRow>();
  let creates = 0;
  let seq = 0;
  const store: FeeStore & { rows: Map<string, FeeRow>; creates: number } = {
    rows,
    get creates() { return creates; },
    findByPayment: async (paymentLogId) => rows.get(paymentLogId) ?? null,
    createPending: async (data) => {
      if (rows.has(data.paymentLogId)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      creates++;
      const row: FeeRow = {
        id: `fee-${++seq}`, amountReceived: null, status: 'PENDING',
        txHash: null, deferredReason: null, circleTxId: null, createdAt: new Date(), ...data,
      };
      rows.set(data.paymentLogId, row);
      return row;
    },
    createDeferred: async (data) => {
      if (rows.has(data.paymentLogId)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      creates++;
      const row: FeeRow = {
        id: `fee-${++seq}`, amountReceived: null, status: 'DEFERRED',
        txHash: null, circleTxId: null, idempotencyKey: null,
        createdAt: new Date(), ...data, deferredReason: (data as any).deferredReason ?? null,
      };
      rows.set(data.paymentLogId, row);
      return row;
    },
    setCircleTxId: async (id, circleTxId) => {
      for (const r of rows.values()) if (r.id === id) r.circleTxId = circleTxId;
    },
    markSuccess: async (id, data) => {
      for (const r of rows.values()) if (r.id === id) { r.status = 'SUCCESS'; r.txHash = data.txHash; r.amountReceived = data.amountReceived; return r; }
      throw new Error('missing');
    },
    markFailedTerminal: async (id, reason) => {
      for (const r of rows.values()) if (r.id === id) { r.status = 'FAILED'; r.circleTxId = null; r.deferredReason = reason; }
    },
    markUnknown: async (id) => {
      for (const r of rows.values()) if (r.id === id) r.status = 'PENDING';
    },
    serialize: async (_key, fn) => fn(store),
  };
  return store;
}

function fakePorts(over: Partial<FeeTransferPorts & { calls: string[]; keys: string[] }> = {}) {
  const calls: string[] = [];
  const keys: string[] = [];
  const ports: FeeTransferPorts & { calls: string[]; keys: string[] } = {
    calls, keys,
    createTransfer: async (p) => { calls.push('create'); keys.push(p.idempotencyKey); return { circleTxId: `circle-${calls.length}` }; },
    pollTransfer: async (circleTxId) => `0xarc-${circleTxId}`,
    ...over,
  };
  return ports;
}

const COLLECT = {
  kind: 'collect' as const,
  walletId: 'wallet-1', walletAddress: MERCHANT, destinationAddress: OTHER,
  amountStr: '0.0025', tokenAddress: USDC_TN, decimals: 6,
};

async function main() {
  // Startup sweep: remove leftovers from previously crashed runs (same
  // HARDEN- prefix, older run id). Current-run rows don't exist yet.
  {
    const stale = await prisma.paymentLog.findMany({ where: { reference: { startsWith: 'HARDEN-' } } });
    for (const r of stale) {
      await (prisma as any).directPaymentProof.deleteMany({ where: { paymentLogId: r.id } }).catch(() => null);
      await (prisma as any).platformFee.deleteMany({ where: { paymentLogId: r.id } }).catch(() => null);
      await prisma.paymentLog.delete({ where: { id: r.id } }).catch(() => null);
    }
    if (stale.length > 0) console.log(`(swept ${stale.length} stale HARDEN rows from prior runs)`);
  }
  console.log('\n[H1-A] same proof -> same invoice sequential replay');
  {
    const ref = REF('A');
    const pay = await mkPayment(ref);
    const first = await settleDirectPaymentAtomic({
      db: prisma, reference: ref, paymentId: pay.id,
      chainId: CHAIN_TESTNET, txHash: TX, logIndex: 3,
      successData: { status: 'SUCCESS', arcTxHash: TX },
    });
    ok('first claim settles', first.payment.status === 'SUCCESS' && first.resumed === false);
    const second = await settleDirectPaymentAtomic({
      db: prisma, reference: ref, paymentId: pay.id,
      chainId: CHAIN_TESTNET, txHash: TX, logIndex: 3,
      successData: { status: 'SUCCESS', arcTxHash: TX },
    });
    ok('replay resumes idempotently', second.payment.status === 'SUCCESS' && second.resumed === true);
    const proofs = await (prisma as any).directPaymentProof.findMany({ where: { paymentLogId: pay.id } });
    ok('exactly one proof row', proofs.length === 1, `rows=${proofs.length}`);
    await cleanup([ref]);
  }

  console.log('\n[H1-B] same proof -> different invoice');
  {
    const r1 = REF('B1'); const r2 = REF('B2');
    const p1 = await mkPayment(r1); const p2 = await mkPayment(r2);
    await settleDirectPaymentAtomic({
      db: prisma, reference: r1, paymentId: p1.id,
      chainId: CHAIN_TESTNET, txHash: TX, logIndex: 7,
      successData: { status: 'SUCCESS', arcTxHash: TX },
    });
    let status = 0;
    try {
      await settleDirectPaymentAtomic({
        db: prisma, reference: r2, paymentId: p2.id,
        chainId: CHAIN_TESTNET, txHash: TX, logIndex: 7,
        successData: { status: 'SUCCESS', arcTxHash: TX },
      });
    } catch (e: any) { status = e?.status ?? 0; }
    ok('second invoice rejected with 409', status === 409, `status=${status}`);
    const live2 = await prisma.paymentLog.findUnique({ where: { reference: r2 } });
    ok('second invoice stays PENDING', live2?.status === 'PENDING', `${live2?.status}`);
    const proof = await (prisma as any).directPaymentProof.findUnique({
      where: { chainId_txHash_logIndex: { chainId: CHAIN_TESTNET, txHash: TX.toLowerCase(), logIndex: 7 } },
    });
    ok('proof still bound to first invoice', proof?.paymentLogId === p1.id);
    await cleanup([r1, r2]);
  }

  console.log('\n[H1-C] unrelated transfer cannot pay an unrelated invoice');
  {
    const need = parseUnits('1', 6);
    ok('wrong merchant -> no match', findDirectTransfer(
      [transferLog(OTHER, need, USDC_TN, 0)],
      { tokenAddress: USDC_TN, merchantSCA: MERCHANT, expectedAmount: need }) === null);
    ok('insufficient amount -> no match', findDirectTransfer(
      [transferLog(MERCHANT, need - 1n, USDC_TN, 0)],
      { tokenAddress: USDC_TN, merchantSCA: MERCHANT, expectedAmount: need }) === null);
    ok('wrong token contract -> no match', findDirectTransfer(
      [transferLog(MERCHANT, need, EURC_TN, 0)],
      { tokenAddress: USDC_TN, merchantSCA: MERCHANT, expectedAmount: need }) === null);
    ok('non-Transfer log skipped', findDirectTransfer(
      [{ address: USDC_TN, data: '0x', topics: [], logIndex: 0 }],
      { tokenAddress: USDC_TN, merchantSCA: MERCHANT, expectedAmount: need }) === null);
    const hit = findDirectTransfer(
      [transferLog(OTHER, 1n, USDC_TN, 0), transferLog(MERCHANT, need, USDC_TN, 5)],
      { tokenAddress: USDC_TN, merchantSCA: MERCHANT, expectedAmount: need });
    ok('qualifying log matches with exact logIndex', hit?.from === OTHER && hit?.logIndex === 5, `${hit?.from}/${hit?.logIndex}/${hit?.value?.toString()}`);
    // Temporal binding: transfer mined before the invoice cannot settle it.
    let tStatus = 0;
    try {
      assertTransferNotPredatingInvoice({
        blockTimestampSec: Math.floor(Date.now() / 1000) - 3600,
        invoiceCreatedAt: new Date(),
      });
    } catch (e: any) { tStatus = e?.status ?? 0; }
    ok('predating transfer rejected', tStatus === 400, `status=${tStatus}`);
    let tOk = false;
    try {
      assertTransferNotPredatingInvoice({
        blockTimestampSec: Math.floor(Date.now() / 1000),
        invoiceCreatedAt: new Date(Date.now() - 600_000),
      });
      tOk = true;
    } catch { tOk = false; }
    ok('later transfer passes temporal check', tOk);
  }

  console.log('\n[H1-D] concurrent one-proof -> many invoices (exactly one winner)');
  {
    const refs = Array.from({ length: 8 }, (_, i) => REF(`D${i}`));
    const pays: Array<{ id: string }> = [];
    for (const r of refs) pays.push(await mkPayment(r));
    const settled = await raceEach(8, (i) =>
      settleDirectPaymentAtomic({
        db: prisma, reference: refs[i]!, paymentId: pays[i]!.id,
        chainId: CHAIN_TESTNET, txHash: TX2, logIndex: 1,
        successData: { status: 'SUCCESS', arcTxHash: TX2 },
      }));
    const wins = valuesOf(settled);
    const rejects = rejectionsOf(settled);
    const conflicts = rejects.filter((e) => e?.status === 409);
    ok('exactly one winner', wins.length === 1, `wins=${wins.length}`);
    ok('all seven losers get 409', rejects.length === 7 && conflicts.length === 7,
      `rejects=${rejects.length} conflicts=${conflicts.length} other=${rejects.filter((e) => e?.status !== 409).map((e) => `${e?.code}/${e?.status}`).join(',')}`);
    const proofs = await (prisma as any).directPaymentProof.findMany({
      where: { chainId: CHAIN_TESTNET, txHash: TX2.toLowerCase(), logIndex: 1 },
    });
    ok('exactly one proof row in DB', proofs.length === 1, `rows=${proofs.length}`);
    const settledCount = await prisma.paymentLog.count({
      where: { reference: { in: refs }, status: 'SUCCESS' },
    });
    ok('exactly one invoice SUCCESS', settledCount === 1, `settled=${settledCount}`);
    await cleanup(refs);
  }

  console.log('\n[H1-E] concurrent same-invoice same-proof');
  {
    const ref = REF('E');
    const pay = await mkPayment(ref);
    const settledE = await raceEach(6, () =>
      settleDirectPaymentAtomic({
        db: prisma, reference: ref, paymentId: pay.id,
        chainId: CHAIN_TESTNET, txHash: TX, logIndex: 9,
        successData: { status: 'SUCCESS', arcTxHash: TX },
      }));
    const valsE = valuesOf(settledE);
    const okAll = valsE.length === 6 && valsE.every((v: any) => v.payment.status === 'SUCCESS');
    ok('all concurrent verifications succeed', okAll, `fulfilled=${valsE.length}`);
    const proofs = await (prisma as any).directPaymentProof.findMany({ where: { paymentLogId: pay.id } });
    ok('one proof row total', proofs.length === 1, `rows=${proofs.length}`);
    await cleanup([ref]);
  }

  console.log('\n[H1-F] failed verification never poisons the claim');
  {
    const ref = REF('F');
    const pay = await mkPayment(ref);
    // Failed match attempts create nothing (matcher is pure, pre-claim).
    const miss = findDirectTransfer(
      [transferLog(OTHER, 1n, USDC_TN, 0)],
      { tokenAddress: USDC_TN, merchantSCA: MERCHANT, expectedAmount: parseUnits('5', 6) });
    ok('failed match returns null without claiming', miss === null);
    const stray = await (prisma as any).directPaymentProof.findMany({ where: { paymentLogId: pay.id } });
    ok('no proof row after failed match', stray.length === 0);
    // Rolled-back claims leave nothing behind.
    await prisma.$transaction(async (db: any) => {
      await db.directPaymentProof.create({
        data: { chainId: CHAIN_TESTNET, txHash: TX.toLowerCase(), logIndex: 11, paymentLogId: pay.id },
      });
      throw new Error('simulated verification failure after claim');
    }).catch(() => null);
    const afterRollback = await (prisma as any).directPaymentProof.findMany({ where: { paymentLogId: pay.id } });
    ok('rolled-back claim leaves no row', afterRollback.length === 0);
    // The same proof still settles afterwards.
    const late = await settleDirectPaymentAtomic({
      db: prisma, reference: ref, paymentId: pay.id,
      chainId: CHAIN_TESTNET, txHash: TX, logIndex: 11,
      successData: { status: 'SUCCESS', arcTxHash: TX },
    });
    ok('proof usable after prior failures', late.payment.status === 'SUCCESS' && !late.resumed);
    await cleanup([ref]);
  }

  console.log('\n[H1-G] routed/CCTP behavior intact');
  {
    const route = read('src/app/api/payments/verify-onchain/route.ts');
    ok('canonical routed branch preserved', route.includes('findRoutedEvent') && route.includes('checkRoutedExecution'));
    ok('unitflow branch preserved', route.includes('verifyCheckoutUnitFlow') && route.includes("unitflow-v3"));
    ok('routed claim pattern preserved', route.includes('claimTxSlot') && route.includes('recheckExecutionConsumerTx'));
    ok('CCTP settle untouched (USDC-only)', read('src/app/api/payments/cctp-settle/route.ts').includes('cctpToken'));
    ok('proof claim sits in the success transaction', route.includes('settleDirectPaymentAtomic'));
  }

  console.log('\n[FEE-1] concurrent fee settlement -> exactly ONE transfer');
  {
    const store = fakeFeeStore();
    const ports = fakePorts();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      settlePlatformFeeOnce({
        store, ports, paymentLogId: 'pay-1', merchantId: 'm-1',
        amountCharged: 0.0025, decision: COLLECT,
      })));
    ok('all ten resolve', results.every((r) => r.status === 'fulfilled'));
    ok('exactly one Circle transfer initiated', ports.calls.length === 1, `calls=${ports.calls.length}`);
    ok('single fee row SUCCESS', store.rows.get('pay-1')?.status === 'SUCCESS');
    ok('idempotency key derived from payment', ports.keys[0] === feeIdempotencyKey('pay-1'), `${ports.keys[0]}`);
  }

  console.log('\n[FEE-2] crash after anchor -> retry resumes, no second transfer');
  {
    const store = fakeFeeStore();
    let crashed = true;
    const ports = fakePorts({
      pollTransfer: async (id) => {
        if (crashed) { crashed = false; throw new Error('process crash before poll (simulated)'); }
        return `0xarc-${id}`;
      },
    });
    const first = await settlePlatformFeeOnce({
      store, ports, paymentLogId: 'pay-2', merchantId: 'm-1', amountCharged: 0.0025, decision: COLLECT,
    });
    ok('crash recorded as unknown-finality (not terminal)', first.action === 'failed' && String((first as any).reason).startsWith('unknown-finality'));
    const anchored = store.rows.get('pay-2');
    ok('circleTxId anchored despite crash', !!anchored?.circleTxId && anchored.status === 'PENDING');
    const createsBefore = ports.calls.length;
    const retry = await settlePlatformFeeOnce({
      store, ports, paymentLogId: 'pay-2', merchantId: 'm-1', amountCharged: 0.0025, decision: COLLECT,
    });
    ok('retry resumes to collected', retry.action === 'resumed' || retry.action === 'collected', retry.action);
    ok('no second transfer on retry', ports.calls.length === createsBefore, `calls=${ports.calls.length}`);
  }

  console.log('\n[FEE-3] terminal failure -> retry reuses SAME idempotency key');
  {
    const store = fakeFeeStore();
    let attempt = 0;
    const ports = fakePorts({
      pollTransfer: async (id) => {
        if (++attempt === 1) throw new Error('Circle tx failed: INSUFFICIENT_FUNDS');
        return `0xarc-${id}`;
      },
    });
    await settlePlatformFeeOnce({
      store, ports, paymentLogId: 'pay-3', merchantId: 'm-1', amountCharged: 0.0025, decision: COLLECT,
    });
    ok('terminal failure recorded FAILED without id', store.rows.get('pay-3')?.status === 'FAILED' && !store.rows.get('pay-3')?.circleTxId);
    await settlePlatformFeeOnce({
      store, ports, paymentLogId: 'pay-3', merchantId: 'm-1', amountCharged: 0.0025, decision: COLLECT,
    });
    ok('retry transfers again (nothing live)', ports.calls.length === 2, `calls=${ports.calls.length}`);
    ok('same idempotency key reused', ports.keys[0] === ports.keys[1] && ports.keys[0] === feeIdempotencyKey('pay-3'));
    ok('second attempt collected', store.rows.get('pay-3')?.status === 'SUCCESS');
  }

  console.log('\n[FEE-4/5] failure never throws; in-progress duplicates skip');
  {
    const store = fakeFeeStore();
    const ports = fakePorts({ createTransfer: async () => { throw new Error('Both native and fallback initialization failed. Error: no'); } });
    let threw = false;
    let outcome: any = null;
    try {
      outcome = await settlePlatformFeeOnce({
        store, ports, paymentLogId: 'pay-4', merchantId: 'm-1', amountCharged: 0.0025, decision: COLLECT,
      });
    } catch { threw = true; }
    ok('fee failure returns outcome, never throws', !threw && outcome?.action === 'failed');
    // In-progress: fresh PENDING without id is owned by a live flight.
    const store2 = fakeFeeStore();
    const ports2 = fakePorts();
    await store2.createPending({ paymentLogId: 'pay-5', merchantId: 'm-1', amountCharged: 0.0025, idempotencyKey: feeIdempotencyKey('pay-5') });
    const dup = await settlePlatformFeeOnce({
      store: store2, ports: ports2, paymentLogId: 'pay-5', merchantId: 'm-1',
      amountCharged: 0.0025, decision: COLLECT,
    });
    ok('in-progress duplicate skips', dup.action === 'skipped' && ports2.calls.length === 0, `${dup.action}/${ports2.calls.length}`);
  }

  console.log('\n[FEE-6] prisma store: concurrent claims -> one PENDING row (final DB state)');
  {
    const ref = REF('FEE6');
    const pay = await mkPayment(ref);
    const store = prismaPlatformFeeStore();
    const mkPorts = (): FeeTransferPorts => ({
      createTransfer: async () => { await new Promise((r) => setTimeout(r, 50)); return { circleTxId: `circle-${ref}` }; },
      pollTransfer: async (id) => `0xarc-${id}`,
    });
    const settledF = await raceEach(6, () =>
      settlePlatformFeeOnce({
        store, ports: mkPorts(), paymentLogId: pay.id, merchantId: 'm-fee6',
        amountCharged: 0.0025, decision: COLLECT,
      }));
    ok('all resolve (transients retried)', valuesOf(settledF).length === 6 && rejectionsOf(settledF).length === 0,
      `rejected=${rejectionsOf(settledF).map((e) => `${e?.code}/${e?.status}/${String(e?.message ?? e).slice(0, 60)}`).join(' | ')}`);
    const rows = await (prisma as any).platformFee.findMany({ where: { paymentLogId: pay.id } });
    ok('exactly one fee row in DB', rows.length === 1, `rows=${rows.length}`);
    // NOTE: each racer used its own ports fake, so transfer-call counts across
    // fakes are not asserted here — FEE-1 proves single-transfer with shared
    // ports; here the losers must all skip-or-resume without creating rows.
    const okStates = ['SUCCESS', 'PENDING'];
    ok('row settles (not duplicated/failed)', okStates.includes(rows[0]?.status), `${rows[0]?.status}`);
    await cleanup([ref]);
  }

  console.log('\n[NET] authoritative chain config, no stale testnet');
  {
    const route = read('src/app/api/payments/verify-onchain/route.ts');
    ok('no wagmi arcTestnet import', !route.includes('lib/wagmi') && !route.includes('arcTestnet'));
    ok('uses getArcChain + getNetworkConfig', route.includes('getArcChain()') && route.includes('getNetworkConfig()'));
    ok('chain bound per request with primaryRpc', route.includes('http(cfg.primaryRpc)') || route.includes('http(getNetworkConfig().primaryRpc)'));
    const canon = read('src/lib/routing/canonical.ts');
    ok('canonical client uses authoritative chain', canon.includes('getArcChain()') && !canon.includes('lib/wagmi'));
    const cfg = getNetworkConfig();
    ok('testnet chain id consistent', getArcChain().id === cfg.chainId && cfg.chainId === 5042002, `id=${getArcChain().id}`);
    // Synthetic mainnet resolution (no secrets, in-memory env only).
    const mainEnv: Record<string, string | undefined> = {
      ...process.env,
      ARC_NETWORK: 'mainnet',
      ARC_MAINNET_CHAIN_ID: '5042',
      ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
      ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io',
      ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.io',
      ARC_MAINNET_GATEWAY_URL: 'https://gateway-api.circle.com',
      ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.com/v2',
      ARC_MAINNET_CCTP_DOMAIN: '26',
      ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      ARC_MAINNET_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
      ARC_MAINNET_EURC_ADDRESS: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
      ARC_MAINNET_X402_VERIFIER: '0x3333333333333333333333333333333333333333',
    };
    const mCfg = getNetworkConfig(mainEnv);
    const mChain = getArcChain(mainEnv);
    ok('mainnet resolves chain 5042 + mainnet RPC', mCfg.chainId === 5042 && mChain.id === 5042 && mCfg.primaryRpc.includes('mainnet'), `${mCfg.chainId}/${mCfg.primaryRpc}`);
    ok('mainnet never inherits testnet RPC', !mCfg.primaryRpc.includes('testnet') && !mCfg.fallbackRpcs.some((u) => u.includes('testnet')));
  }

  console.log('\n[USDC] mainnet USDC-only enforcement');
  {
    const mainEnv: Record<string, string | undefined> = {
      ...process.env,
      ARC_NETWORK: 'mainnet',
      ARC_MAINNET_CHAIN_ID: '5042',
      ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
      ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io',
      ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.io',
      ARC_MAINNET_GATEWAY_URL: 'https://gateway-api.circle.com',
      ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.com/v2',
      ARC_MAINNET_CCTP_DOMAIN: '26',
      ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      ARC_MAINNET_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
      ARC_MAINNET_EURC_ADDRESS: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
      ARC_MAINNET_X402_VERIFIER: '0x3333333333333333333333333333333333333333',
    };
    let eurcBlocked = false;
    try { assertMainnetSettlementAllowed('EURC', mainEnv); } catch (e: any) { eurcBlocked = e?.status === 400; }
    ok('mainnet EURC refused by gate', eurcBlocked);
    let usdcOk = false;
    try { assertMainnetSettlementAllowed('USDC', mainEnv); usdcOk = true; } catch { usdcOk = false; }
    ok('mainnet USDC passes gate', usdcOk);
    let testnetEurcOk = false;
    try { assertMainnetSettlementAllowed('EURC', process.env as any); testnetEurcOk = true; } catch { testnetEurcOk = false; }
    ok('testnet EURC behavior preserved', testnetEurcOk);
    for (const f of [
      'src/app/api/payments/verify-onchain/route.ts',
      'src/app/api/payments/initialize/route.ts',
      'src/app/api/payments/settle/route.ts',
    ]) {
      ok(`${f.split('/').slice(-2).join('/')} enforces gate`, read(f).includes('assertMainnetSettlementAllowed'));
    }
    ok('payment-link already USDC-only', read('src/app/api/merchant/payment-link/route.ts').includes("getTokenBySymbol('USDC')"));

    // LIVE attacker-bypass proof: flip the process network to synthetic
    // mainnet, create a EURC invoice, and call verify-onchain directly —
    // no auth, no UI, exactly the attacker's path. Must 400 BEFORE any RPC.
    const savedEnv = { ...process.env };
    const refs: string[] = [];
    try {
      for (const k of Object.keys(mainEnv)) (process.env as any)[k] = mainEnv[k];
      __resetNetworkConfigCacheForTests();
      const eurcAddr = mainEnv.ARC_MAINNET_EURC_ADDRESS!;
      const eurcRef = REF('USDC-EURC');
      refs.push(eurcRef);
      await mkPayment(eurcRef, { currency: 'EURC', tokenAddress: eurcAddr });
      const { POST } = await import('@/src/app/api/payments/verify-onchain/route');
      const mkReq = (body: any) => new Request('http://localhost/api/payments/verify-onchain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }) as any;
      const eurcRes: any = await POST(mkReq({ reference: eurcRef, txHash: TX }));
      const eurcBody = await eurcRes.json().catch(() => ({}));
      ok('attacker EURC verify rejected (400)', eurcRes.status === 400 && /USDC only/i.test(eurcBody?.error ?? ''), `${eurcRes.status} ${eurcBody?.error ?? ''}`);
      const eurcRow = await prisma.paymentLog.findUnique({ where: { reference: eurcRef } });
      ok('EURC invoice untouched (still PENDING)', eurcRow?.status === 'PENDING');
      const eurcProofs = eurcRow
        ? await (prisma as any).directPaymentProof.findMany({ where: { paymentLogId: eurcRow.id } })
        : [];
      ok('no proof row for rejected EURC', eurcProofs.length === 0);

      const usdcRef = REF('USDC-USDC');
      refs.push(usdcRef);
      await mkPayment(usdcRef, { currency: 'USDC', tokenAddress: mainEnv.ARC_MAINNET_USDC_ADDRESS! });
      const usdcRes: any = await POST(mkReq({ reference: usdcRef, txHash: TX }));
      const usdcBody = await usdcRes.json().catch(() => ({}));
      const passedGate = !(usdcRes.status === 400 && /USDC only/i.test(usdcBody?.error ?? ''));
      ok('mainnet USDC passes the gate (reaches chain check)', passedGate, `${usdcRes.status} ${usdcBody?.error ?? ''}`);
      const usdcRow = await prisma.paymentLog.findUnique({ where: { reference: usdcRef } });
      ok('USDC invoice not falsely settled without proof', usdcRow?.status !== 'SUCCESS');
    } finally {
      for (const k of Object.keys(mainEnv)) {
        if (savedEnv[k] === undefined) delete (process.env as any)[k];
        else (process.env as any)[k] = savedEnv[k];
      }
      __resetNetworkConfigCacheForTests();
      await cleanup(refs);
    }
  }

  console.log(`\n done: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('failures:'); for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('SUITE ERROR', e); await prisma.$disconnect(); process.exit(1); });
