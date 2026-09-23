// scripts/scheduled-resume-tests.ts
//
// P1-2 regression: ONE scheduled execution period produces AT MOST ONE Circle
// transfer — even across crash-recovery and concurrent workers.
//
// Uses the REAL production modules (trackedTransfer.ts, scheduledExecution.ts)
// with in-memory fakes for the PaymentLog store and the Circle API: no DB, no
// network, no funds. Run: npx tsx scripts/scheduled-resume-tests.ts
//
// Matrix:
//   1. first execution succeeds (1 creation, completion runs once)
//   2. transfer created + persisted, process fails before normal completion
//      -> stale claim reclaimed -> tracked tx resumed -> NO second transfer
//   3. concurrent workers on the same period -> exactly one creation
//   4. FAILED tracked transfer is terminal -> fresh creation allowed once
//   5. poll timeout keeps the tracked ID -> resume completes, no new creation
//   6. fresh PROCESSING-without-ID claim blocks a second creation (in flight)
//   7. stale PROCESSING-without-ID claim is safe to take over (owner crashed
//      before creation — no tracked transfer exists)
//   8. period key stability: same (id, runCount) -> same claim row across restarts
//   9. schedule-advance math (incl. maxRuns completion)
//  10. route wiring: run/route.ts actually uses the tracked executor with a
//      per-period key and a conditional (exactly-once) schedule advancement

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CircleTxFailedError,
  executeTrackedTransfer,
  TransferInProgressError,
  type CircleLike,
  type TrackedTransferArgs,
  type TrackedTransferStore,
} from '@/src/lib/payments/trackedTransfer';
import {
  computeScheduleAdvance,
  scheduledPeriodKey,
  scheduledPeriodReference,
} from '@/src/lib/payments/scheduledExecution';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const noSleep = async (_ms: number): Promise<void> => {};

// ─── In-memory fakes ─────────────────────────────────────────────────────────

interface FakeRow {
  status: string;
  circleTxId: string | null;
  arcTxHash: string | null;
  timestamp: Date;
  [k: string]: unknown;
}

/** PaymentLog store fake with real unique-key (P2002) semantics. */
class FakeStore implements TrackedTransferStore {
  rows = new Map<string, FakeRow>();
  async findByIdempotencyKey(key: string): Promise<FakeRow | null> {
    await tick();
    return this.rows.get(key) ?? null;
  }
  async createClaim(data: Record<string, unknown>): Promise<FakeRow> {
    await tick();
    const key = data['idempotencyKey'] as string;
    if (this.rows.has(key)) {
      const e = new Error('Unique constraint failed on the fields: (`idempotencyKey`)') as Error & {
        code?: string;
      };
      e.code = 'P2002';
      throw e;
    }
    const row: FakeRow = {
      status: 'PROCESSING',
      circleTxId: null,
      arcTxHash: null,
      timestamp: new Date(),
      ...data,
    };
    this.rows.set(key, row);
    return row;
  }
  async setCircleTxId(key: string, circleTxId: string): Promise<void> {
    await tick();
    this.rows.get(key)!.circleTxId = circleTxId;
  }
  async mark(
    key: string,
    data: { status: string; arcTxHash?: string | null; circleTxId?: string | null }
  ): Promise<void> {
    await tick();
    Object.assign(this.rows.get(key)!, data);
  }
}

type CircleBehavior = 'complete' | 'fail' | 'never';

/** Circle API fake: creation returns an ID immediately (pre-finality), polling resolves later. */
class FakeCircle implements CircleLike {
  creations = 0;
  polls = new Map<string, number>();
  behavior: CircleBehavior = 'complete';
  async createTransaction(_args: unknown): Promise<unknown> {
    this.creations++;
    const id = `ctx-${this.creations}`;
    this.polls.set(id, 0);
    return { data: { id } };
  }
  async createContractExecutionTransaction(_args: unknown): Promise<unknown> {
    return this.createTransaction(_args);
  }
  async getTransaction(args: { id: string }): Promise<unknown> {
    const n = (this.polls.get(args.id) ?? 0) + 1;
    this.polls.set(args.id, n);
    if (this.behavior === 'fail') {
      return { data: { transaction: { state: 'FAILED', errorReason: 'INSUFFICIENT_FUNDS' } } };
    }
    if (this.behavior === 'never') {
      return { data: { transaction: { state: 'PENDING' } } };
    }
    return { data: { transaction: { state: 'COMPLETE', txHash: `0xhash-${args.id}` } } };
  }
}

const PERIOD = { id: 'sched-1', runCount: 3, reference: 'rent-alice' };

function scheduledArgs(
  store: FakeStore,
  circle: FakeCircle,
  overrides?: Partial<TrackedTransferArgs>
): TrackedTransferArgs {
  return {
    store,
    circle,
    idempotencyKey: scheduledPeriodKey(PERIOD),
    claimData: {
      reference: scheduledPeriodReference(PERIOD),
      amount: 5,
      currency: 'USDC',
      tokenAddress: '0x3600000000000000000000000000000000000000',
      chain: 'ARC-TESTNET',
      senderEmail: 'scheduled-payment-system',
      merchant: '0xreceiver',
      agentSCA: '0xpayer',
      payerSCA: '0xpayer',
    },
    createNative: () => circle.createTransaction({}),
    createFallback: () => circle.createContractExecutionTransaction({}),
    sleep: noSleep,
    ...overrides,
  };
}

// ─── 1. First execution succeeds ─────────────────────────────────────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  let confirmed = 0;
  const res = await executeTrackedTransfer(
    scheduledArgs(store, circle, { onConfirmed: async () => { confirmed++; } })
  );
  ok('1a first execution creates exactly one transfer', circle.creations === 1, `creations=${circle.creations}`);
  ok('1b completion runs exactly once', confirmed === 1, `confirmed=${confirmed}`);
  ok('1c returns the on-chain hash, not replayed/resumed', res.txHash === '0xhash-ctx-1' && !res.replayed && !res.resumed, JSON.stringify(res));
  const row = await store.findByIdempotencyKey(scheduledPeriodKey(PERIOD));
  ok('1d claim row is SUCCESS with tracked + on-chain IDs', row?.status === 'SUCCESS' && row?.circleTxId === 'ctx-1' && row?.arcTxHash === '0xhash-ctx-1', JSON.stringify(row));
}

// ─── 2. Crash after persist, before completion -> resume, no 2nd transfer ───
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  // Attempt 1: transfer is created and its ID persisted, then the process
  // "crashes" inside completion (before schedule advancement + SUCCESS mark).
  let attempt = 0;
  const crashing = async (): Promise<void> => {
    attempt++;
    if (attempt === 1) throw new Error('process crashed before normal completion');
  };
  let err1: unknown = null;
  try {
    await executeTrackedTransfer(scheduledArgs(store, circle, { onConfirmed: crashing }));
  } catch (e) {
    err1 = e;
  }
  ok('2a first attempt fails like a crash', err1 instanceof Error && /crashed/.test(err1.message), String((err1 as Error)?.message));
  ok('2b exactly one transfer was created before the crash', circle.creations === 1, `creations=${circle.creations}`);
  const mid = await store.findByIdempotencyKey(scheduledPeriodKey(PERIOD));
  ok('2c tracked ID survived the crash (not SUCCESS)', mid?.circleTxId === 'ctx-1' && mid?.status !== 'SUCCESS', JSON.stringify(mid));

  // Attempt 2 ("restarted" process, stale claim reclaimed): must resume.
  let confirmed2 = 0;
  const res2 = await executeTrackedTransfer(
    scheduledArgs(store, circle, { onConfirmed: async () => { confirmed2++; } })
  );
  ok('2d recovery creates NO second transfer', circle.creations === 1, `creations=${circle.creations}`);
  ok('2e recovery resumes the tracked transfer', res2.resumed && !res2.replayed && res2.txHash === '0xhash-ctx-1', JSON.stringify(res2));
  ok('2f completion runs on recovery', confirmed2 === 1, `confirmed2=${confirmed2}`);
  const end = await store.findByIdempotencyKey(scheduledPeriodKey(PERIOD));
  ok('2g claim row ends SUCCESS', end?.status === 'SUCCESS', end?.status ?? 'null');
}

// ─── 3. Concurrent workers -> exactly one creation ───────────────────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  const settled = await Promise.allSettled([
    executeTrackedTransfer(scheduledArgs(store, circle, { sleep: noSleep })),
    executeTrackedTransfer(scheduledArgs(store, circle, { sleep: noSleep })),
  ]);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
  ok('3a exactly one Circle transfer across concurrent workers', circle.creations === 1, `creations=${circle.creations}`);
  ok('3b at least one worker succeeds (loser gets InProgress or resumes)', fulfilled >= 1, JSON.stringify(settled.map((s) => s.status)));
  const loserRejected = settled.some(
    (s) => s.status === 'rejected' && (s.reason instanceof TransferInProgressError || s.reason?.name === 'TransferInProgressError')
  );
  const bothResumed = settled.every(
    (s) => s.status === 'fulfilled' && (s.value.resumed || !s.value.replayed)
  );
  ok('3c loser never creates (InProgress or idempotent resume)', loserRejected || bothResumed, JSON.stringify(settled.map((s) => (s.status === 'rejected' ? String(s.reason) : JSON.stringify(s.value)))));
}

// ─── 4. FAILED tracked transfer is terminal -> one fresh creation ────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  circle.behavior = 'fail';
  let err: unknown = null;
  try {
    await executeTrackedTransfer(scheduledArgs(store, circle));
  } catch (e) {
    err = e;
  }
  ok('4a failed transfer surfaces CircleTxFailedError', err instanceof CircleTxFailedError || (err as Error)?.name === 'CircleTxFailedError', String((err as Error)?.message));
  const mid = await store.findByIdempotencyKey(scheduledPeriodKey(PERIOD));
  ok('4b failed ID is discarded (not kept for resume)', mid?.circleTxId === null && mid?.status === 'FAILED', JSON.stringify(mid));
  circle.behavior = 'complete';
  const res = await executeTrackedTransfer(scheduledArgs(store, circle));
  ok('4c retry after terminal failure creates exactly one fresh transfer', circle.creations === 2 && res.txHash === '0xhash-ctx-2' && !res.resumed, `creations=${circle.creations} res=${JSON.stringify(res)}`);
}

// ─── 5. Timeout keeps the ID -> resume completes, no new creation ────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  circle.behavior = 'never';
  let err: unknown = null;
  try {
    await executeTrackedTransfer(scheduledArgs(store, circle, { pollAttempts: 3 }));
  } catch (e) {
    err = e;
  }
  ok('5a poll timeout surfaces', err instanceof Error && /timed out/.test(err.message), String((err as Error)?.message));
  const mid = await store.findByIdempotencyKey(scheduledPeriodKey(PERIOD));
  ok('5b timed-out ID stays tracked (SETTLEMENT_ERROR)', mid?.circleTxId === 'ctx-1' && mid?.status === 'SETTLEMENT_ERROR', JSON.stringify(mid));
  circle.behavior = 'complete';
  const res = await executeTrackedTransfer(scheduledArgs(store, circle));
  ok('5c resume after timeout creates no new transfer', circle.creations === 1 && res.resumed && res.txHash === '0xhash-ctx-1', `creations=${circle.creations} res=${JSON.stringify(res)}`);
}

// ─── 6/7. Fresh vs stale PROCESSING-without-ID ───────────────────────────────
{
  // Fresh (live flight): second creation refused.
  const store = new FakeStore();
  const circle = new FakeCircle();
  await store.createClaim({ reference: 'x', idempotencyKey: 'k-fresh', amount: 1 });
  let err: unknown = null;
  try {
    await executeTrackedTransfer({
      store,
      circle,
      idempotencyKey: 'k-fresh',
      claimData: { reference: 'x' },
      createNative: () => circle.createTransaction({}),
      createFallback: () => circle.createContractExecutionTransaction({}),
      sleep: noSleep,
    });
  } catch (e) {
    err = e;
  }
  ok('6 fresh in-flight claim blocks a second creation', (err instanceof TransferInProgressError || (err as Error)?.name === 'TransferInProgressError') && circle.creations === 0, `${String((err as Error)?.message)} creations=${circle.creations}`);

  // Stale (owner crashed before creation — no tracked ID exists): takeover.
  const store2 = new FakeStore();
  const circle2 = new FakeCircle();
  await store2.createClaim({ reference: 'y', idempotencyKey: 'k-stale', amount: 1 });
  store2.rows.get('k-stale')!.timestamp = new Date(Date.now() - 10 * 60 * 1000);
  const res = await executeTrackedTransfer({
    store: store2,
    circle: circle2,
    idempotencyKey: 'k-stale',
    claimData: { reference: 'y' },
    createNative: () => circle2.createTransaction({}),
    createFallback: () => circle2.createContractExecutionTransaction({}),
    sleep: noSleep,
  });
  ok('7 stale claim with no tracked transfer is taken over exactly once', circle2.creations === 1 && res.txHash === '0xhash-ctx-1', `creations=${circle2.creations}`);
}

// ─── 8. Period key stability ─────────────────────────────────────────────────
{
  const k1 = scheduledPeriodKey({ id: 'abc', runCount: 0 });
  const k2 = scheduledPeriodKey({ id: 'abc', runCount: 0 });
  const k3 = scheduledPeriodKey({ id: 'abc', runCount: 1 });
  ok('8a same period -> same key across restarts', k1 === k2, `${k1} vs ${k2}`);
  ok('8b next period -> different key', k1 !== k3, `${k1} vs ${k3}`);
  ok('8c reference is unique per period', scheduledPeriodReference({ reference: 'r', runCount: 0 }) !== scheduledPeriodReference({ reference: 'r', runCount: 1 }));
}

// ─── 9. Schedule-advance math ────────────────────────────────────────────────
{
  const now = new Date('2026-09-23T12:00:00.000Z');
  const mid = computeScheduleAdvance({ runCount: 2, maxRuns: 5, intervalDays: 30 }, now);
  ok('9a mid-schedule stays ACTIVE with nextRunAt one interval out', mid.status === 'ACTIVE' && mid.newRunCount === 3 && mid.nextRunAt.getTime() === now.getTime() + 30 * 86400000, JSON.stringify(mid));
  const last = computeScheduleAdvance({ runCount: 4, maxRuns: 5, intervalDays: 7 }, now);
  ok('9b final run COMPLETES', last.status === 'COMPLETED' && last.isComplete, JSON.stringify(last));
  const open = computeScheduleAdvance({ runCount: 9, maxRuns: null, intervalDays: 1 }, now);
  ok('9c open-ended schedule never completes', open.status === 'ACTIVE' && !open.isComplete, JSON.stringify(open));
}

// ─── 10. Route wiring (static — proves the live route uses this) ────────────
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(path.join(root, 'src/app/api/payments/scheduled/run/route.ts'), 'utf8');
  ok('10a route executes via the tracked executor', /executeTrackedTransfer\(/.test(src));
  ok('10b route keys the claim per period (id + runCount)', /scheduledPeriodKey\(\{ id: scheduled\.id, runCount: scheduled\.runCount \}\)/.test(src));
  ok('10c schedule advancement is conditional (exactly-once per period)', /scheduledPayment\.updateMany\(\{\s*\n?\s*where: \{ id: scheduled\.id, status: 'PROCESSING', runCount: scheduled\.runCount \}/.test(src));
  ok('10d no unconditional schedule update remains', !/scheduledPayment\.update\(\{\s*\n?\s*where: \{ id: scheduled\.id \}/.test(src));
  ok('10e in-progress periods are skipped without releasing the claim', /TransferInProgressError/.test(src) && /without releasing|leave its claim|already being processed/.test(src));
  ok('10f atomic per-row claim retained (layer 1)', /scheduledPayment\.updateMany\(\{\s*\n?\s*where: \{\s*\n?\s*id: scheduled\.id,\s*\n?\s*status: scheduled\.status,/.test(src));
}

console.log(`\nscheduled-resume: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('failures:', failures.join(' | '));
  process.exit(1);
}
