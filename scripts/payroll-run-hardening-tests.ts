// scripts/payroll-run-hardening-tests.ts
//
// H8 — /api/payroll/run hardening:
//   1. strict amount validation (negative / NaN / malformed / >6 decimals
//      / bad recipientSCA → 400, nothing created)
//   2. idempotency: same idempotencyKey → replay of the ORIGINAL batch
//      (exactly one batch row; the replay never re-executes payments)
//   3. concurrent duplicates with one key → both 200, exactly one batch row
//   4. GET tenant scoping: merchant B cannot read merchant A's batch (404)
//
// Run: npx tsx scripts/payroll-run-hardening-tests.ts   (dev server required)

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

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

async function main() {
  if (!(await waitForServer())) {
    console.log('FAIL dev server not reachable');
    process.exit(1);
  }

  const merchantA = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true },
  });
  const merchantB = await prisma.merchant.findFirst({
    where: { businessName: 'tower', verified: true, active: true },
  });
  if (!merchantA?.apiKey || !merchantB?.apiKey) {
    console.log('FAIL test merchants missing');
    process.exit(1);
  }
  const keyA = merchantA.apiKey;
  const keyB = merchantB.apiKey;
  const headersA = { 'x-api-key': keyA, 'content-type': 'application/json' };
  const headersB = { 'x-api-key': keyB, 'content-type': 'application/json' };

  const deadRecipient = '0x000000000000000000000000000000000000dEaD';
  const tag = `h8-${Date.now()}`;

  // ── 1. Validation ────────────────────────────────────────────────────
  console.log('[validation]');
  const badPayloads: Array<[string, any]> = [
    ['NaN amount', { recipients: [{ recipientSCA: deadRecipient, amount: 'abc' }] }],
    ['negative amount', { recipients: [{ recipientSCA: deadRecipient, amount: '-1.5' }] }],
    ['zero amount', { recipients: [{ recipientSCA: deadRecipient, amount: '0' }] }],
    ['malformed 1e3', { recipients: [{ recipientSCA: deadRecipient, amount: '1e3' }] }],
    ['excess precision (7 decimals)', { recipients: [{ recipientSCA: deadRecipient, amount: '0.1234567' }] }],
    ['empty recipients', { recipients: [] }],
    ['missing recipients', {}],
    ['bad recipientSCA', { recipients: [{ recipientSCA: 'not-an-address', amount: '1' }] }],
    ['too many recipients', { recipients: Array.from({ length: 201 }, () => ({ recipientSCA: deadRecipient, amount: '1' })) }],
  ];
  for (const [label, body] of badPayloads) {
    const res = await fetch(`${BASE}/api/payroll/run`, { method: 'POST', headers: headersA, body: JSON.stringify(body) });
    ok(`${label} → 400`, res.status === 400, `got ${res.status}`);
  }

  // ── 2. Idempotency ───────────────────────────────────────────────────
  console.log('[idempotency]');
  const idemKey = `${tag}-key`;
  const first = await fetch(`${BASE}/api/payroll/run`, {
    method: 'POST',
    headers: headersA,
    body: JSON.stringify({
      idempotencyKey: idemKey,
      recipients: [{ recipientSCA: deadRecipient, amount: '0.001', label: 'h8' }],
    }),
  });
  const firstBody = await first.json().catch(() => ({}));
  ok('first POST accepted (200)', first.status === 200, `got ${first.status} ${firstBody.error ?? ''}`);
  const batchRef = firstBody.batchRef;
  ok('batchRef returned', typeof batchRef === 'string' && batchRef.startsWith('payroll_idem_'), batchRef);

  const rowsAfterFirst = await prisma.payrollBatch.count({ where: { batchRef } });
  ok('exactly one batch row after first POST', rowsAfterFirst === 1, `count ${rowsAfterFirst}`);

  const second = await fetch(`${BASE}/api/payroll/run`, {
    method: 'POST',
    headers: headersA,
    body: JSON.stringify({
      idempotencyKey: idemKey,
      recipients: [{ recipientSCA: deadRecipient, amount: '0.001', label: 'h8' }],
    }),
  });
  const secondBody = await second.json().catch(() => ({}));
  ok('duplicate POST replays (200, replayed:true)', second.status === 200 && secondBody.replayed === true,
    `got ${second.status} replayed=${secondBody.replayed}`);
  ok('replay returns the SAME batchRef', secondBody.batchRef === batchRef, secondBody.batchRef);
  // Prisma JSON fields can reorder object keys on read — compare semantically.
  const norm = (o: any) => JSON.stringify(o, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
  ok('replay returns the SAME results', norm(secondBody.results) === norm(firstBody.results));
  const rowsAfterSecond = await prisma.payrollBatch.count({ where: { batchRef } });
  ok('still exactly one batch row after duplicate POST', rowsAfterSecond === 1, `count ${rowsAfterSecond}`);

  // ── 3. Concurrent duplicates ─────────────────────────────────────────
  console.log('[concurrency]');
  const idemKey2 = `${tag}-key2`;
  const [c1, c2] = await Promise.all([
    fetch(`${BASE}/api/payroll/run`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ idempotencyKey: idemKey2, recipients: [{ recipientSCA: deadRecipient, amount: '0.001' }] }),
    }),
    fetch(`${BASE}/api/payroll/run`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ idempotencyKey: idemKey2, recipients: [{ recipientSCA: deadRecipient, amount: '0.001' }] }),
    }),
  ]);
  const bodies = await Promise.all([c1.json().catch(() => ({})), c2.json().catch(() => ({}))]);
  const refs = bodies.map((b: any) => b.batchRef).filter(Boolean);
  ok('both concurrent POSTs answered 200', c1.status === 200 && c2.status === 200, `got ${c1.status}/${c2.status}`);
  ok('both resolve to the same batchRef', refs.length === 2 && refs[0] === refs[1], JSON.stringify(refs));
  const rowsConc = await prisma.payrollBatch.count({ where: { batchRef: refs[0] } });
  ok('exactly one batch row under concurrency', rowsConc === 1, `count ${rowsConc}`);

  // ── 4. GET tenant scoping ────────────────────────────────────────────
  console.log('[GET scoping]');
  const ownGet = await fetch(`${BASE}/api/payroll/run?batchRef=${batchRef}`, { headers: headersA });
  ok('owning merchant reads its batch (200)', ownGet.status === 200, `got ${ownGet.status}`);
  const otherGet = await fetch(`${BASE}/api/payroll/run?batchRef=${batchRef}`, { headers: headersB });
  ok('other merchant gets 404 for a foreign batch', otherGet.status === 404, `got ${otherGet.status}`);
  const unauthGet = await fetch(`${BASE}/api/payroll/run?batchRef=${batchRef}`);
  ok('unauthenticated GET → 401', unauthGet.status === 401, `got ${unauthGet.status}`);

  // ── cleanup ──────────────────────────────────────────────────────────
  await prisma.payrollBatch.deleteMany({ where: { batchRef: { startsWith: `payroll_idem_${tag}` } } }).catch(() => {});
  await prisma.$disconnect();

  console.log(`\npayroll-run-hardening-tests: ${checks} checks, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('payroll-run-hardening-tests crashed:', e);
  process.exit(1);
});