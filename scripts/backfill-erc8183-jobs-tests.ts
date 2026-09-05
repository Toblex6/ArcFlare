// scripts/backfill-erc8183-jobs-tests.ts
// ─────────────────────────────────────────────────────────────────────────────
// Focused tests for the idempotent pre-Track-3 Direct-Hire Erc8183Job backfill.
//
// The core (`scripts/erc8183JobBackfill.ts`) is pure — chain reads and DB
// writes are injected — so these run WITHOUT a live RPC or database, using an
// in-memory fake Erc8183Job store and a fake chain.
//
// Required coverage (per the task):
//   1. dry-run behavior
//   2. one valid historical record → backfilled
//   3. already-backfilled record → skipped, never overwritten
//   4. missing on-chain record → skipped (missing-on-chain)
//   5. ambiguous legacy data → skipped (ambiguous)
//   6. mismatched DB/on-chain data → skipped (mismatch)
//   7. repeated execution is idempotent (no duplicate)
//   8. no duplicate Erc8183Job for the same jobId
//
// Run: npx tsx scripts/backfill-erc8183-jobs-tests.ts
// No dev server / DB / chain required.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type LegacyJobRow,
  type OnChainJob,
  type Erc8183JobCreateData,
  parseLegacyJobId,
  runBackfill,
} from './erc8183JobBackfill';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const ZERO = '0x' + '0'.repeat(40);

function legacy(id: string, overrides: Partial<LegacyJobRow> = {}): LegacyJobRow {
  return {
    id,
    description: 'Build a dashboard',
    amount: 100, // Float USDC estimate at create-time
    status: 'PENDING',
    agentId: B, // historical direct-hire stored providerSCA here
    merchantId: 'merchant-1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function chain(id: bigint, overrides: Partial<OnChainJob> = {}): OnChainJob {
  return {
    id,
    client: A,
    provider: B,
    evaluator: ZERO, // default: means "was not provided" → falls back to client
    description: 'Build a dashboard',
    budget: 100000000n, // 100 USDC in 6-dec
    expiredAt: 1785542400n, // some unix seconds in the future
    status: 0, // OPEN
    hook: ZERO,
    ...overrides,
  };
}

// A fake Erc8183Job store (Map keyed by jobId string) + chain map.
function makeHarness(chainMap: Map<bigint, OnChainJob>, seed: Erc8183JobCreateData[] = []) {
  const store = new Map<string, Erc8183JobCreateData>();
  for (const row of seed) store.set(row.jobId.toString(), row);
  const initialStoreSnapshot = store.size;

  const harness = {
    store,
    looksUnchanged() {
      return store.size === initialStoreSnapshot;
    },
    async run(candidates: LegacyJobRow[], dryRun: boolean, persist = true) {
      return runBackfill({
        candidates,
        existing: async (jobId) => store.has(jobId.toString()),
        chainRead: async (jobId) => {
          const job = chainMap.get(jobId);
          return job ? { kind: 'exists' as const, job } : { kind: 'missing' as const };
        },
        persist: persist
          ? async (payload: Erc8183JobCreateData) => {
              const k = payload.jobId.toString();
              if (store.has(k)) {
                const err: any = new Error('unique constraint');
                err.code = 'P2002';
                throw err;
              }
              store.set(k, payload);
            }
          : undefined,
        dryRun,
      });
    },
  };
  return harness;
}
async function main() {
  console.log('── Backfill (erc8183) — focused tests ─────────────────────');

  // 0. helper sanity
  ok('parseLegacyJobId("erc8183_42") → 42n', parseLegacyJobId('erc8183_42') === 42n);
  ok('parseLegacyJobId("erc8183_abc") → null', parseLegacyJobId('erc8183_abc') === null);
  ok('parseLegacyJobId("foo") → null', parseLegacyJobId('foo') === null);

  // 1. dry-run behavior — nothing persisted, row reported as backfillable.
  {
    console.log('\n[T1] dry-run behavior');
    const h = makeHarness(new Map([[7n, chain(7n)]]));
    const r = await h.run([legacy('erc8183_7')], true);
    ok('dry-run reports 1 backfillable', r.backfilled.length === 1);
    ok('dry-run marks wouldBackfill=true', r.backfilled[0]!.wouldBackfill === true);
    ok('dry-run carries reconstructed payload', r.backfilled[0]!.payload?.jobId === 7n);
    ok('dry-run does NOT write any row', h.looksUnchanged());
    ok('dry-run no duplicates', r.noDuplicate === true);
  }

  // 2. one valid historical record → applied (persisted), all fields proven.
  {
    console.log('\n[T2] one valid historical record');
    const h = makeHarness(new Map([[7n, chain(7n)]]));
    const r = await h.run([legacy('erc8183_7')], false);
    ok('applied backfills exactly 1', r.backfilled.length === 1);
    const row = h.store.get('7');
    ok('persisted a row', Boolean(row));
    ok('jobId from on-chain', row?.jobId === 7n);
    ok('clientSCA from on-chain', row?.clientSCA === A);
    ok('providerSCA from on-chain', row?.providerSCA === B);
    ok('evaluator falls back to client when 0x0', row?.evaluatorSCA === A);
    ok('description from on-chain', row?.description === 'Build a dashboard');
    ok('budget from on-chain (6-dec)', row?.budget === 100000000n);
    ok('status maps 0→OPEN', row?.status === 'OPEN');
    ok('txHashes default to []', Array.isArray(row?.txHashes) && row!.txHashes.length === 0);
    ok('merchantId carried from legacy', row?.merchantId === 'merchant-1');
    ok('agentId left null (not reconstructable)', row?.agentId === null);
    ok('no duplicates', r.noDuplicate === true);
  }

  // 3. already-backfilled record → skipped, existing row untouched.
  {
    console.log('\n[T3] already-backfilled record');
    const seed: Erc8183JobCreateData = {
      jobId: 7n,
      clientSCA: A,
      providerSCA: B,
      evaluatorSCA: A,
      description: 'Build a dashboard',
      budget: 100000000n,
      status: 'COMPLETED',
      deliverableHash: null,
      reasonHash: null,
      txHashes: ['0xabc'],
      hook: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      expiredAt: new Date(),
      agentId: null,
      merchantId: 'merchant-1',
    };
    const h = makeHarness(new Map([[7n, chain(7n)]]), [seed]);
    const r = await h.run([legacy('erc8183_7')], false);
    ok('already-backfilled is skipped', r.backfilled.length === 0);
    ok('skipped with reason already-backfilled',
      r.skipped.some((s) => s.reason === 'already-backfilled' && s.jobId === 7n));
    ok('existing row NOT overwritten (txHashes preserved)', h.store.get('7')!.txHashes[0] === '0xabc');
    ok('existing status NOT overwritten (still COMPLETED)', h.store.get('7')!.status === 'COMPLETED');
  }

  // 4. missing on-chain record → skipped (missing-on-chain), no write.
  {
    console.log('\n[T4] missing on-chain record');
    const h = makeHarness(new Map()); // no on-chain job for any id
    const r = await h.run([legacy('erc8183_7')], false);
    ok('missing-on-chain skipped', r.backfilled.length === 0);
    ok('skipped with reason missing-on-chain',
      r.skipped.some((s) => s.reason === 'missing-on-chain' && s.jobId === 7n));
    ok('no row written', h.looksUnchanged());
  }
// 5. ambiguous legacy data → skipped (ambiguous).
  {
    console.log('\n[T5] ambiguous legacy data');
    // 5a. unparseable legacy id (not a valid `erc8183_<n>` mirror)
    const h1 = makeHarness(new Map([[7n, chain(7n)]]));
    const r1 = await h1.run([legacy('legacy-uuid-row', { agentId: 'some-uuid' })], false);
    ok('unparseable legacy id → ambiguous', r1.skipped.some((s) => s.reason === 'ambiguous'));
    ok('unparseable legacy id → nothing written', h1.looksUnchanged());

    // 5b. on-chain status out of 0..5 → can't be mapped without guessing
    const h2 = makeHarness(new Map([[7n, chain(7n, { status: 99 })]]));
    const r2 = await h2.run([legacy('erc8183_7')], false);
    ok('out-of-range on-chain status → ambiguous (never guessed)',
      r2.skipped.some((s) => s.reason === 'ambiguous' && s.jobId === 7n));
    ok('out-of-range status → nothing written', h2.looksUnchanged());
  }

  // 6. mismatched DB/on-chain data → skipped (mismatch).
  {
    console.log('\n[T6] mismatched DB/on-chain data');
    const h1 = makeHarness(new Map([[7n, chain(7n, { description: 'Something else' })]]));
    const r1 = await h1.run([legacy('erc8183_7')], false);
    ok('description mismatch → skipped', r1.skipped.some((s) => s.reason === 'mismatch'));
    ok('description mismatch recorded', r1.mismatch.some((m) => m.field === 'description' && m.jobId === 7n));
    ok('description mismatch → nothing written', h1.looksUnchanged());

    const h2 = makeHarness(new Map([[7n, chain(7n, { provider: C })]]));
    const r2 = await h2.run([legacy('erc8183_7')], false);
    ok('provider mismatch → skipped', r2.skipped.some((s) => s.reason === 'mismatch'));
    ok('provider mismatch recorded', r2.mismatch.some((m) => m.field === 'provider' && m.jobId === 7n));
    ok('provider mismatch → nothing written', h2.looksUnchanged());
  }

  // 7. repeated execution is idempotent.
  {
    console.log('\n[T7] repeated execution is idempotent');
    const h = makeHarness(new Map([[7n, chain(7n)]]));
    const candidates = [legacy('erc8183_7')];
    const r1 = await h.run(candidates, false);
    ok('first run backfills', r1.backfilled.length === 1);
    const rowsAfterFirst = h.store.size;
    const r2 = await h.run(candidates, false);
    ok('second run backfills 0 (already present)', r2.backfilled.length === 0);
    ok('second run skipped as already-backfilled',
      r2.skipped.some((s) => s.reason === 'already-backfilled'));
    ok('store size unchanged after re-run (no duplicate rows)',
      h.store.size === rowsAfterFirst && rowsAfterFirst === 1);
    ok('idempotent run still reports no duplicates', r2.noDuplicate === true);
  }

  // 8. no duplicate Erc8183Job when two legacy rows map to the same jobId.
  {
    console.log('\n[T8] no duplicate Erc8183Job (same jobId twice in a run)');
    const h = makeHarness(new Map([[7n, chain(7n)]]));
    const candidates = [legacy('erc8183_7'), legacy('erc8183_7')];
    const r = await h.run(candidates, false);
    ok('exactly one job backfilled', r.backfilled.length === 1);
    ok('exactly one row persisted', h.store.size === 1);
    ok('second candidate treated as already-backfilled (in-run dedupe)',
      r.skipped.filter((s) => s.reason === 'already-backfilled').length === 1);
    ok('noDuplicate flag true', r.noDuplicate === true);
  }

  // 9. concurrent unique-violation (P2002) is treated as already-backfilled.
  {
    console.log('\n[T9] concurrent P2002 unique violation is safe');
    const seed: Erc8183JobCreateData = {
      jobId: 7n, clientSCA: A, providerSCA: B, evaluatorSCA: A,
      description: 'Build a dashboard', budget: 100000000n, status: 'OPEN',
      deliverableHash: null, reasonHash: null, txHashes: [], hook: null,
      createdAt: new Date(), expiredAt: new Date(), agentId: null, merchantId: null,
    };
    const h2 = makeHarness(new Map([[7n, chain(7n)]]), [seed]);
    const r = await runBackfill({
      candidates: [legacy('erc8183_7')],
      existing: async () => false, // existing() missed it, but persist collides
      chainRead: async () => ({ kind: 'exists' as const, job: chain(7n) }),
      persist: async (p) => {
        if (h2.store.has(p.jobId.toString())) { const e: any = new Error('dup'); e.code = 'P2002'; throw e; }
        h2.store.set(p.jobId.toString(), p);
      },
      dryRun: false,
    });
    ok('P2002 → skipped as already-backfilled (no throw)', r.skipped.some((s) => s.reason === 'already-backfilled'));
    ok('P2002 → nothing double-written', h2.store.size === 1);
  }

  console.log(`\n── ${passed} passed, ${failed} failed ──────────────────────`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  • ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('test harness crashed:', e);
  process.exit(2);
});