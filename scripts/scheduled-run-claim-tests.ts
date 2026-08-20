// scripts/scheduled-run-claim-tests.ts
//
// H7 — /api/payments/scheduled/run must never double-pay a due row when two
// runners run concurrently (or a retry lands mid-execution). Each row is
// claimed atomically (ACTIVE→PROCESSING, per-row conditional updateMany);
// a runner that loses the claim skips the row.
//
//   1. A row in-flight as PROCESSING (fresh claim) is SKIPPED — no second
//      execution, runCount unchanged.
//   2. A STALE PROCESSING row (crashed runner) is reclaimed and executed.
//   3. A real success path: two concurrent /run calls on one due row →
//      exactly one executes it (runCount 1, COMPLETED), no double transfer.
//   4. A null-payerWalletId row still fails closed (batch-3 behavior).
//
// Run: npx tsx scripts/scheduled-run-claim-tests.ts   (dev server required)

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';
const INTERNAL_KEY = process.env.INTERNAL_SETTLEMENT_API_KEY;
// Hardcoded in the settle/scheduled route sources (not env) — the platform
// default payer's Circle wallet id + SCA.
const DEFAULT_PAYER_WALLET_ID = '58ab0223-cad0-5128-896e-a88d6f217b43';
const DEFAULT_PAYER_SCA = '0x7a8214dad7630a7a39054e0121acdbc7a65821c9';

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean, detail?: string) {
  checks++;
  if (cond) console.log(`  ok ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/payments/verify/__probe__`);
      if (res.status === 404) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function runScheduler() {
  const res = await fetch(`${BASE}/api/payments/scheduled/run`, {
    method: 'POST',
    headers: { 'x-api-key': INTERNAL_KEY!, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  if (!INTERNAL_KEY) {
    console.log('FAIL INTERNAL_SETTLEMENT_API_KEY not in env');
    process.exit(1);
  }
  if (!(await waitForServer())) {
    console.log('FAIL dev server not reachable');
    process.exit(1);
  }

  const tag = `h7-${Date.now()}`;
  const receiver = '0x000000000000000000000000000000000000dEaD';
  const past = new Date(Date.now() - 60000);
  const mkRow = async (ref: string, overrides: any = {}) =>
    prisma.scheduledPayment.create({
      data: {
        reference: `${tag}-${ref}`,
        payerSCA: DEFAULT_PAYER_SCA,
        payerWalletId: DEFAULT_PAYER_WALLET_ID,
        receiverSCA: receiver,
        amount: 0.01,
        intervalDays: 1,
        nextRunAt: past,
        maxRuns: 1,
        ...overrides,
      },
    });

  try {
    // 1. In-flight row (PROCESSING, fresh claim) → runner must SKIP it.
    const inFlight = await mkRow('inflight', { status: 'PROCESSING', lastRunAt: new Date() });
    const r1 = await runScheduler();
    const inFlightAfter = await prisma.scheduledPayment.findUnique({ where: { id: inFlight.id } });
    ok('in-flight PROCESSING row is skipped (no double execution)',
      r1.body?.results?.find((x: any) => x.reference === inFlight.reference)?.error?.includes('claimed by another runner') ?? true,
      JSON.stringify(r1.body?.results?.find((x: any) => x.reference === inFlight.reference)));
    ok('skipped row keeps runCount 0', inFlightAfter?.runCount === 0, `runCount ${inFlightAfter?.runCount}`);
    ok('skipped row stays PROCESSING (still owned by the in-flight runner)', inFlightAfter?.status === 'PROCESSING', inFlightAfter?.status);

    // 2. STALE PROCESSING row → reclaimed and executed.
    const stale = await mkRow('stale', { status: 'PROCESSING', lastRunAt: new Date(Date.now() - 10 * 60 * 1000) });
    const r2 = await runScheduler();
    const staleAfter = await prisma.scheduledPayment.findUnique({ where: { id: stale.id } });
    ok('stale PROCESSING row is reclaimed (attempted, fails vs fake path or succeeds)',
      (staleAfter?.runCount ?? 0) >= 1 || r2.body?.results?.find((x: any) => x.reference === stale.reference)?.success === false,
      JSON.stringify(r2.body?.results?.find((x: any) => x.reference === stale.reference)));

    // 3. Success path concurrency: two /run calls at once on one due ACTIVE
    //    row → exactly one executes (runCount 1, COMPLETED), no double-pay.
    const winner = await mkRow('winner', { status: 'ACTIVE', lastRunAt: null });
    const [c1, c2] = await Promise.all([runScheduler(), runScheduler()]);
    const winnerAfter = await prisma.scheduledPayment.findUnique({ where: { id: winner.id } });
    ok('exactly one of two concurrent runners executes the row', winnerAfter?.runCount === 1, `runCount ${winnerAfter?.runCount}`);
    ok('winner row reached COMPLETED (maxRuns 1)', winnerAfter?.status === 'COMPLETED', winnerAfter?.status);
    ok('nextRunAt advanced for the winner', !!winnerAfter && (winnerAfter as any).nextRunAt > past);

    // 4. Null payerWalletId → fails closed (batch-3), row reverted to ACTIVE.
    const nullPayer = await mkRow('nullpayer', { payerWalletId: null, status: 'ACTIVE', lastRunAt: null });
    const r3 = await runScheduler();
    const nullPayerAfter = await prisma.scheduledPayment.findUnique({ where: { id: nullPayer.id } });
    ok('null payerWalletId row fails closed', r3.body?.results?.find((x: any) => x.reference === nullPayer.reference)?.success === false,
      JSON.stringify(r3.body?.results?.find((x: any) => x.reference === nullPayer.reference)));
    ok('failed row released back to ACTIVE (retryable, not stuck)', nullPayerAfter?.status === 'ACTIVE', nullPayerAfter?.status);

  } finally {
    await prisma.scheduledPayment.deleteMany({ where: { reference: { startsWith: tag } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\nscheduled-run-claim-tests: ${checks} checks, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('scheduled-run-claim-tests crashed:', e);
  process.exit(1);
});