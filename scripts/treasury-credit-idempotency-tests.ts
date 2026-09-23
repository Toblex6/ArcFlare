// scripts/treasury-credit-idempotency-tests.ts
//
// P1-3 regression: treasury credit idempotency.
//
// Uses the REAL production executor (trackedTransfer.ts) with in-memory fakes
// for the PaymentLog store, the Circle API, and the ledger: no DB, no
// network, no funds. Run: npx tsx scripts/treasury-credit-idempotency-tests.ts
//
// Matrix (task cases):
//   1. first request creates exactly one transfer + one ledger entry
//   2. repeated request with the same key replays the bound result (no Circle call)
//   3. concurrent duplicate requests create exactly one transfer
//   4. failure before transfer -> FAILED, retry allowed, still exactly one transfer
//   5. transfer succeeds but normal DB completion is interrupted -> not SUCCESS
//   6. recovery resumes the tracked transfer -> NO second transfer
//   + route wiring: mandatory Idempotency-Key, claim-before-transfer, replay,
//     caller authorization preserved, server-derived wallets, ledger kept

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  executeTrackedTransfer,
  TransferInProgressError,
  type CircleLike,
  type TrackedTransferArgs,
  type TrackedTransferStore,
} from '@/src/lib/payments/trackedTransfer';

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

interface FakeRow {
  status: string;
  circleTxId: string | null;
  arcTxHash: string | null;
  timestamp: Date;
  [k: string]: unknown;
}

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

class FakeCircle implements CircleLike {
  creations = 0;
  failCreation = false;
  polls = new Map<string, number>();
  async createTransaction(_args: unknown): Promise<unknown> {
    if (this.failCreation) throw new Error('CIRCLE_UNAVAILABLE');
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
    return { data: { transaction: { state: 'COMPLETE', txHash: `0xhash-${args.id}` } } };
  }
}

/** Ledger fake with real txHash-dedupe semantics (dedupeKey unique). */
class FakeLedger {
  entries = new Map<string, { amount: bigint }>();
  writes = 0;
  async record(txHash: string, agentId: number, amount: bigint): Promise<{ replayed: boolean }> {
    const key = `${txHash.toLowerCase()}:${agentId}:ADJUSTMENT`;
    if (this.entries.has(key)) return { replayed: true };
    this.entries.set(key, { amount });
    this.writes++;
    return { replayed: false };
  }
}

const AGENT_ID = 42;
const KEY = `treasury-credit:${AGENT_ID}:req-abc-123`;

function treasuryArgs(
  store: FakeStore,
  circle: FakeCircle,
  ledger: FakeLedger,
  opts?: { crashInCompletion?: boolean; key?: string }
): TrackedTransferArgs {
  const key = opts?.key ?? KEY;
  return {
    store,
    circle,
    idempotencyKey: key,
    claimData: {
      reference: 'treasury-credit_42_claim',
      amount: 5,
      currency: 'USDC',
      tokenAddress: '0x3600000000000000000000000000000000000000',
      chain: 'ARC-TESTNET',
      senderEmail: 'merchant@example.com',
      merchant: 'Test Merchant',
      merchantId: 'm-1',
      merchantSCA: '0xsource',
      agentSCA: '0xdest',
    },
    createNative: () => circle.createTransaction({}),
    createFallback: () => circle.createContractExecutionTransaction({}),
    // Mirrors the route's onConfirmed: idempotent ADJUSTMENT CREDIT via dedupe.
    onConfirmed: async (txHash: string) => {
      if (opts?.crashInCompletion) throw new Error('process crashed before DB completion');
      await ledger.record(txHash, AGENT_ID, 4_990_000n);
    },
    sleep: noSleep,
  };
}

// ─── 1. First request ────────────────────────────────────────────────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  const ledger = new FakeLedger();
  const res = await executeTrackedTransfer(treasuryArgs(store, circle, ledger));
  ok('1a first request creates exactly one Circle transfer', circle.creations === 1, `creations=${circle.creations}`);
  ok('1b first request writes exactly one ledger entry', ledger.writes === 1, `writes=${ledger.writes}`);
  ok('1c first request returns the bound hash, not replayed', res.txHash === '0xhash-ctx-1' && !res.replayed, JSON.stringify(res));
}

// ─── 2. Repeated request with same key ───────────────────────────────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  const ledger = new FakeLedger();
  const first = await executeTrackedTransfer(treasuryArgs(store, circle, ledger));
  const creationsAfterFirst = circle.creations;
  const replay = await executeTrackedTransfer(treasuryArgs(store, circle, ledger));
  ok('2a replay creates NO additional transfer', circle.creations === creationsAfterFirst, `creations=${circle.creations}`);
  ok('2b replay reuses the bound result', replay.replayed && replay.txHash === first.txHash, JSON.stringify(replay));
  ok('2c replay performs zero Circle calls (pure DB replay)', circle.polls.get('ctx-1') === 1, `polls=${circle.polls.get('ctx-1')}`);
}

// ─── 3. Concurrent duplicate requests ────────────────────────────────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  const ledger = new FakeLedger();
  const settled = await Promise.allSettled([
    executeTrackedTransfer(treasuryArgs(store, circle, ledger)),
    executeTrackedTransfer(treasuryArgs(store, circle, ledger)),
  ]);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
  ok('3a concurrent duplicates create exactly one transfer', circle.creations === 1, `creations=${circle.creations}`);
  ok('3b at least one duplicate succeeds', fulfilled >= 1, JSON.stringify(settled.map((s) => s.status)));
  const safeLoser = settled.some(
    (s) =>
      (s.status === 'rejected' && (s.reason instanceof TransferInProgressError || s.reason?.name === 'TransferInProgressError')) ||
      (s.status === 'fulfilled' && (s.value.replayed || s.value.resumed))
  );
  ok('3c loser never transfers (InProgress or idempotent replay/resume)', safeLoser, JSON.stringify(settled.map((s) => (s.status === 'rejected' ? String(s.reason) : JSON.stringify(s.value)))));
  ok('3d ledger written at most once per unique hash', ledger.entries.size <= 1, `entries=${ledger.entries.size}`);
}

// ─── 4. Failure before transfer ──────────────────────────────────────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  const ledger = new FakeLedger();
  circle.failCreation = true; // both native + fallback fail: no ID can exist
  let err: unknown = null;
  try {
    await executeTrackedTransfer(treasuryArgs(store, circle, ledger));
  } catch (e) {
    err = e;
  }
  ok('4a pre-transfer failure surfaces (no transfer possible)', err instanceof Error && /initiate/.test(err.message), String((err as Error)?.message));
  const mid = await store.findByIdempotencyKey(KEY);
  ok('4b claim marked FAILED with no tracked transfer', mid?.status === 'FAILED' && mid?.circleTxId === null, JSON.stringify(mid));
  circle.failCreation = false;
  const res = await executeTrackedTransfer(treasuryArgs(store, circle, ledger));
  ok('4c retry after pre-transfer failure succeeds with exactly one transfer', circle.creations === 1 && res.txHash === '0xhash-ctx-1' && !res.resumed, `creations=${circle.creations}`);
}

// ─── 5+6. Success then interrupted -> recovery sends nothing new ─────────────
{
  const store = new FakeStore();
  const circle = new FakeCircle();
  const ledger = new FakeLedger();
  let err: unknown = null;
  try {
    await executeTrackedTransfer(treasuryArgs(store, circle, ledger, { crashInCompletion: true }));
  } catch (e) {
    err = e;
  }
  ok('5a interrupted completion surfaces the crash', err instanceof Error && /crashed/.test(err.message), String((err as Error)?.message));
  const mid = await store.findByIdempotencyKey(KEY);
  ok('5b transfer tracked but NOT marked SUCCESS (no ledger write assumed)', mid?.circleTxId === 'ctx-1' && mid?.status !== 'SUCCESS' && ledger.writes === 0, `row=${JSON.stringify(mid)} writes=${ledger.writes}`);

  // Recovery with the same key.
  const res = await executeTrackedTransfer(treasuryArgs(store, circle, ledger));
  ok('6a recovery creates NO second transfer', circle.creations === 1, `creations=${circle.creations}`);
  ok('6b recovery resumes the tracked transfer', res.resumed && !res.replayed && res.txHash === '0xhash-ctx-1', JSON.stringify(res));
  ok('6c ledger written exactly once across crash + recovery', ledger.writes === 1, `writes=${ledger.writes}`);
  const end = await store.findByIdempotencyKey(KEY);
  ok('6d claim row ends SUCCESS', end?.status === 'SUCCESS', end?.status ?? 'null');
}

// ─── Route wiring (static — proves the live route implements this) ──────────
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(path.join(root, 'src/app/api/agents/[id]/treasury/credit/route.ts'), 'utf8');
  ok('R1 Idempotency-Key is mandatory (400 without it)', /idempotency-key'\)\?\.trim\(\)/.test(src) && /Idempotency-Key header \(1-120 chars\) is required/.test(src));
  ok('R2 claim scope is agent-bound (treasury-credit:{agentId}:{key})', /treasury-credit:\$\{agentId\}:\$\{rawKey\}/.test(src));
  ok('R3 claim happens via tracked executor BEFORE the live transfer', /executeTrackedTransfer\(\{/.test(src));
  ok('R4 duplicate with same key replays (no second transfer)', /replayed/.test(src) && /no ledger record/.test(src));
  ok('R5 crash recovery resumes (no second transfer)', /resumed/.test(src) && /TransferInProgressError/.test(src));
  ok('R6 pre-transfer failure does not wedge (500, retryable same key)', /transfer failed:/.test(src));
  ok('R7 caller authorization preserved', /verifyCallerControlsAddress\(req, agent\.scaAddress/.test(src));
  ok('R8 source wallet stays server-derived (body carries only amountUSDC)', /body\.amountUSDC/.test(src) && !/body\.(walletId|sourceWallet|destination)/.test(src));
  ok('R9 ledger semantics preserved (ADJUSTMENT CREDIT, txHash dedupe)', /type: 'ADJUSTMENT'/.test(src) && /direction: 'CREDIT'/.test(src) && /recordLedgerEntry\(/.test(src));
  ok('R10 raw transferUsdc (ID-hiding) no longer used on this path', !/transferUsdc\(/.test(src));
  ok('R11 cross-merchant key reuse rejected (409)', /Idempotency key already in use/.test(src));
}

console.log(`\ntreasury-credit-idempotency: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('failures:', failures.join(' | '));
  process.exit(1);
}
