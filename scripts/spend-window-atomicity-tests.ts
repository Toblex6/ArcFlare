// scripts/spend-window-atomicity-tests.ts
//
// Atomicity proof for the per-payer windowed-sum limiter
// (src/lib/agents/spendWindow.ts) against the LIVE database:
//   1. a single spend over the cap is rejected
//   2. 20 CONCURRENT small spends that jointly exceed the cap cannot
//      race past it — the final window record equals exactly the sum of
//      the allowed requests (Serializable + FOR UPDATE, not a JS sum)
// Run: npx tsx scripts/spend-window-atomicity-tests.ts

import { prisma } from '@/lib/prisma';
import { enforceSpendLimit, SPEND_WINDOW_CAP_MICROS } from '@/lib/agents/spendWindow';

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

async function main() {
  const payer = `0x${'ace'.repeat(20)}`;
  await prisma.$executeRawUnsafe(`DELETE FROM spend_windows WHERE "payerAddress" = '${payer}'`);

  // 1. single over-cap spend rejected
  const big = await enforceSpendLimit({
    payerAddress: payer,
    amountMicros: SPEND_WINDOW_CAP_MICROS + 1n,
    context: 'atomicity-single',
  });
  ok('single spend over cap → rejected 403', !big.allowed && big.status === 403, JSON.stringify(big.reason ?? ''));

  // 2. concurrent race
  await prisma.$executeRawUnsafe(`DELETE FROM spend_windows WHERE "payerAddress" = '${payer}'`);
  const slice = 250n * 1_000_000n; // 250 USDC — 20 concurrent = 5000 > 2500 cap
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      enforceSpendLimit({ payerAddress: payer, amountMicros: slice, context: 'atomicity-race' })
    )
  );
  const allowedCount = results.filter((r) => r.allowed).length;
  const finalRow = (await prisma.$queryRawUnsafe(
    `SELECT "spentMicros" FROM spend_windows WHERE "payerAddress" = '${payer}'`
  )) as Array<{ spentMicros: bigint }>;
  const finalSpent = BigInt(finalRow[0]?.spentMicros ?? 0);
  const cap = SPEND_WINDOW_CAP_MICROS;

  ok('concurrent spends cannot jointly exceed the cap', finalSpent <= cap, `allowed ${allowedCount}/20, final ${Number(finalSpent) / 1e6} USDC (cap ${Number(cap) / 1e6})`);
  ok('window record == exact sum of allowed requests (no lost update)', finalSpent === BigInt(allowedCount) * slice, `${allowedCount} allowed → ${Number(finalSpent) / 1e6} USDC recorded`);

  await prisma.$executeRawUnsafe(`DELETE FROM spend_windows WHERE "payerAddress" = '${payer}'`);

  console.log(`\nspend-window atomicity: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((e) => { console.error('FATAL:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());


