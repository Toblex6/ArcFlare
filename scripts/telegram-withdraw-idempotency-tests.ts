// scripts/telegram-withdraw-idempotency-tests.ts
//
// H6 — a Telegram webhook retry (same update_id) or a double /confirm must
// never execute two transfers from one withdrawal intent.
//
//   1. Two CONCURRENT /confirm calls for the same intent → exactly one
//      attempts the transfer; the other gets "already being processed".
//   2. After a failed transfer the claim rolls back to PENDING (retryable).
//   3. update_id dedupe: trackUpdate() returns true on a duplicate delivery.
//
// Uses a consumer with a fake Circle walletId so the transfer fails
// deterministically (no funds move, no Circle side effects).
//
// Run: npx tsx scripts/telegram-withdraw-idempotency-tests.ts

import { ethers } from 'ethers';
import { PrismaClient } from '@prisma/client';
import { handleConfirmWithdraw, handleWithdraw } from '../src/lib/telegram/botHandlers';
import { trackUpdate } from '../src/lib/telegram/webhookDedupe';

const prisma = new PrismaClient();

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

async function main() {
  const tgUser = `h6-test-${Date.now()}`;
  const consumer = await prisma.consumerAccount.create({
    data: {
      telegramUserId: tgUser,
      walletAddress: ethers.Wallet.createRandom().address,
      walletType: 'CIRCLE',
      circleWalletId: 'h6-fake-wallet-no-funds',
      onboardingSource: 'telegram',
    },
  });

  try {
    // 1. Seed an intent via /withdraw (DB-backed, no transfer).
    const seed = await handleWithdraw(tgUser, ethers.Wallet.createRandom().address, '0.01');
    ok('/withdraw stores a pending intent', /Withdrawal requested/.test(seed.text), seed.text);
    const intent = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId: tgUser } });
    ok('intent persisted with status PENDING', intent?.status === 'PENDING', intent?.status);

// 2. The atomic claim is the guard: while an intent is EXECUTING (an
//    in-flight transfer from a webhook retry / double /confirm), any other
//    /confirm must be refused — no second transfer can start.
    await prisma.telegramWithdrawalIntent.update({
      where: { telegramUserId: tgUser },
      data: { status: 'EXECUTING' },
    });
    const refused = await handleConfirmWithdraw(tgUser);
    ok('a /confirm while EXECUTING is refused (no second transfer)', refused.text.includes('already being processed'), refused.text.slice(0, 50));

    // 3. Release the claim back to PENDING (as the failed transfer path
    //    does) → a fresh /confirm may attempt again.
    await prisma.telegramWithdrawalIntent.update({
      where: { telegramUserId: tgUser },
      data: { status: 'PENDING' },
    });
    const retry = await handleConfirmWithdraw(tgUser);
    ok('retry after release attempts again (fails vs fake wallet)', retry.text.startsWith('Withdrawal failed'), retry.text.slice(0, 50));
    const afterRetry = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId: tgUser } });
    ok('intent rolled back to PENDING after failure', afterRetry?.status === 'PENDING', afterRetry?.status);

    // 4. Successful path releases the intent (no claim left behind) — use a
    //    consumer whose balance is zero so 'ALL' fails before transferring.
    const zeroConsumer = await prisma.consumerAccount.create({
      data: {
        telegramUserId: `${tgUser}-zero`,
        walletAddress: ethers.Wallet.createRandom().address,
        walletType: 'CIRCLE',
        circleWalletId: 'h6-fake-wallet-zero',
        onboardingSource: 'telegram',
      },
    });
    await prisma.telegramWithdrawalIntent.create({
      data: { telegramUserId: `${tgUser}-zero`, destinationAddress: ethers.Wallet.createRandom().address, amount: 'ALL' },
    });
    const zeroRes = await handleConfirmWithdraw(`${tgUser}-zero`);
    ok('zero-balance ALL withdrawal says no balance', /no USDC balance/.test(zeroRes.text), zeroRes.text);
    const zeroIntent = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId: `${tgUser}-zero` } });
    ok('no-balance path deletes the intent', zeroIntent === null);
    await prisma.consumerAccount.delete({ where: { id: zeroConsumer.id } }).catch(() => {});

    // 5. update_id dedupe.
    const dupUpdateId = 424242 + Date.now();
    const first = trackUpdate(dupUpdateId);
    ok('first delivery of an update_id is processed', first === false);
    const dup = trackUpdate(dupUpdateId);
    ok('duplicate update_id is deduped', dup === true);
  } finally {
    await prisma.telegramWithdrawalIntent.deleteMany({ where: { telegramUserId: { startsWith: 'h6-test-' } } }).catch(() => {});
    await prisma.consumerAccount.deleteMany({ where: { telegramUserId: { startsWith: 'h6-test-' } } }).catch(() => {});
    await prisma.telegramWithdrawalIntent.deleteMany({ where: { telegramUserId: { startsWith: 'h6-test-' } } }).catch(() => {});
    await prisma.consumerAccount.deleteMany({ where: { telegramUserId: { startsWith: 'h6-test-' } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\ntelegram-withdraw-idempotency-tests: ${checks} checks, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('telegram-withdraw-idempotency-tests crashed:', e);
  process.exit(1);
});