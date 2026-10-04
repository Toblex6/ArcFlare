// scripts/merchant-wallet-migration-tests.ts
//
// Merchant mainnet wallet upgrade (Step E) — pure + static tests only.
// No DB, no Circle, no network: provisioning is proven by merchant logins,
// never by an automated live mint.
//
// Run: npx tsx scripts/merchant-wallet-migration-tests.ts
//
// Covers:
//   1. Per-merchant stable idempotency keys (UUIDv4, deterministic,
//      purpose/merchant distinct, namespace-distinct from consumer keys).
//   2. MerchantWalletError shape (status + code passthrough).
//   3. Login hook wiring (merchant/login: 404-only migration, one-time
//      message, walletAddress in response).
//   4. Double-mint safety (advisory lock + FOR UPDATE + post-lock
//      re-check, stable keys in both Circle creates, history append-only).
//   5. Scope (merchants only — no agent writes; CIRCLE-only; mainnet-gated;
//      healthy/id-less merchants pass through).
//   6. Live-address resolution (direct match, history match, unknown
//      passthrough; history rows never rewritten).
//   7. Money-path wiring (nano record/settle destinations, scheduled
//      create/run destinations, settle history branch, withdraw 409s).

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MerchantWalletError,
  merchantMigrationIdempotencyKey,
} from '@/src/lib/merchant/walletMigration';
import { migrationIdempotencyKey as sharedKey } from '@/src/lib/wallets/upgradeGuards';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const UUIDV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

console.log('── 1: merchant idempotency keys ───────────────────────────────');
const k1 = merchantMigrationIdempotencyKey('merch-1', 'set');
ok('UUIDv4 shape', UUIDV4.test(k1), k1);
ok('deterministic', merchantMigrationIdempotencyKey('merch-1', 'set') === k1);
ok('purpose-distinct', merchantMigrationIdempotencyKey('merch-1', 'wallets') !== k1);
ok('merchant-distinct', merchantMigrationIdempotencyKey('merch-2', 'set') !== k1);
ok('namespace-distinct from consumer keys', sharedKey('consumer', 'merch-1', 'set') !== k1);

console.log('── 2: typed error shape ───────────────────────────────────────');
const terr = new MerchantWalletError(409, 'MERCHANT_WALLET_NEEDS_UPDATE', 'msg');
ok('status + code passthrough', terr.status === 409 && terr.code === 'MERCHANT_WALLET_NEEDS_UPDATE');

console.log('── 3–7: wiring (static proofs) ───────────────────────────────');
const mod = read('src/lib/merchant/walletMigration.ts');
ok('404-only creation', mod.includes('isCircleClean404(err)') && mod.includes('WALLET_CHECK_FAILED'));
ok('CIRCLE-only + mainnet-gated', mod.includes("walletProvider !== \"CIRCLE\"") && mod.includes('getNetworkConfig().name !== "mainnet"'));
ok('no agent writes', !/\(prisma as any\)\.agentRegistry/.test(mod));
ok('per-merchant advisory lock + re-check', mod.includes('merchant-wallet-migrate:') && mod.includes('FOR UPDATE') && mod.includes('locked.circleWalletId !== staleId'));
ok('stable keys in both creates', mod.includes('merchantMigrationIdempotencyKey(merchantId, "set")') && mod.includes('merchantMigrationIdempotencyKey(merchantId, "wallets")'));
ok('history append-only', mod.includes('previousWallets') && mod.includes('mainnet-upgrade'));
ok('resolver: direct + history + passthrough', mod.includes('mode: "insensitive"') && mod.includes('previousWallets') && mod.includes('return raw;'));

const login = read('src/app/api/merchant/login/route.ts');
ok('login migrates own CIRCLE row only', login.includes('ensureMerchantMainnetWallet(merchant.id)'));
ok('login shows one-time message + new address', login.includes('walletUpgradedMessage') && login.includes('walletAddress: merchantRow.walletAddress'));
ok('login failure never blocks auth', login.includes('wallet upgrade check failed'));

const settle = read('src/app/api/payments/settle/route.ts');
ok('settle history-maps id-less rows (frozen row untouched)', settle.includes('resolveCurrentMerchantAddress(payment.merchantSCA)'));

const nano = read('src/app/api/payments/nano/route.ts');
ok('nano records/reads CURRENT merchant', nano.includes('liveMerchantSCA'));
const nanoSettle = read('src/app/api/payments/nano/settle/route.ts');
ok('nano/settle pays CURRENT merchant', nanoSettle.includes('liveMerchantSCA'));

const sched = read('src/app/api/payments/scheduled/route.ts');
ok('scheduled create records CURRENT receiver', sched.includes('resolveCurrentMerchantAddress(receiverSCA)'));
const schedRun = read('src/app/api/payments/scheduled/run/route.ts');
ok('scheduled/run pays CURRENT receiver', schedRun.includes('liveReceiverSCA'));

// 2026-10-04 hardening: the identical nested duplicate
// (merchant/merchant/withdraw) was deleted — single withdraw route only.
for (const f of ['src/app/api/merchant/withdraw/route.ts']) {
  const w = read(f);
  ok(`${f.split('/').slice(-2).join('/')} maps stale id to 409`, w.includes('assertMerchantCircleWalletLive(merchant)'));
}

const schema = read('prisma/schema.prisma');
ok('Merchant carries history + notice fields', /model Merchant[\s\S]*?previousWallets[\s\S]*?migrationNoticePending/.test(schema));
const migSql = read('prisma/migrations/20260930000001_merchant_wallet_migration_history/migration.sql');
ok('merchant migration adds the three columns', migSql.includes('"previousWallets"') && migSql.includes('"migrationNoticePending"'));

console.log(`\nmerchant-wallet-migration-tests: ${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
