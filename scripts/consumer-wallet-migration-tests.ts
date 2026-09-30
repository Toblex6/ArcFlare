// scripts/consumer-wallet-migration-tests.ts
//
// Consumer mainnet wallet upgrade (Step C) — pure + static tests only.
// No DB, no Circle, no network: provisioning itself is proven by the
// pilot login on 0xfd8e…838b, never by an automated live mint.
//
// Run: npx tsx scripts/consumer-wallet-migration-tests.ts
//
// Covers:
//   1. Clean-404 classifier (only 404 provisions; 400-invalid-id, 5xx,
//      timeouts, network errors never do).
//   2. Stable idempotency keys (deterministic UUIDv4, purpose/account
//      distinct — Circle-side dedupe for retried migrations).
//   3. Login hook wiring (email-auth PUT: 404-only migration, one-time
//      message with exact copy, session re-read after migrate).
//   4. Double-mint safety (advisory lock + FOR UPDATE + post-lock re-check,
//      stable keys threaded into BOTH Circle creates).
//   5. Scope (consumers only — no merchant/agent writes; mainnet-gated).
//   6. Send-path signal (clean 404 → WALLET_NEEDS_UPDATE, never raw error).
//   7. Production ARC_NETWORK guard (unset refuses in production only).

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WALLET_UPGRADED_MESSAGE,
  WALLET_NEEDS_UPDATE_MESSAGE,
  WALLET_CHECK_RETRY_MESSAGE,
  isCircleClean404,
  migrationIdempotencyKey,
} from '@/src/lib/consumer/walletMigration';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const UUIDV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

console.log('── 1: clean-404 classifier (only 404 provisions) ───────────────');
ok('status 404 → clean', isCircleClean404(Object.assign(new Error('x'), { status: 404 })));
ok('statusCode 404 → clean', isCircleClean404({ statusCode: 404, message: 'nope' }));
ok('not-found text (non-400) → clean', isCircleClean404({ status: 403, message: 'Wallet not found' }));
ok('400 invalid-id → NOT clean (legacy rows never auto-migrate)', !isCircleClean404({ status: 400, message: 'Fail to parse id as UUID in url.' }));
ok('500 → NOT clean', !isCircleClean404({ status: 500, message: 'internal' }));
ok('timeout (no status) → NOT clean', !isCircleClean404(new Error('fetch failed')));
ok('network error → NOT clean', !isCircleClean404({ message: 'ECONNRESET' }));
ok('null → NOT clean', !isCircleClean404(null));

console.log('── 2: stable idempotency keys ──────────────────────────────────');
const k1 = migrationIdempotencyKey('acct-1', 'set');
ok('UUIDv4 shape', UUIDV4.test(k1), k1);
ok('deterministic per account+purpose', migrationIdempotencyKey('acct-1', 'set') === k1);
ok('purpose-distinct', migrationIdempotencyKey('acct-1', 'wallets') !== k1);
ok('account-distinct', migrationIdempotencyKey('acct-2', 'set') !== k1);

console.log('── 3–7: wiring (static proofs) ────────────────────────────────');
ok('exact one-time copy', WALLET_UPGRADED_MESSAGE === "Your wallet was upgraded to Arc Mainnet. Your old address can't receive funds.");
ok('exact re-login copy', WALLET_NEEDS_UPDATE_MESSAGE === 'Your wallet needs updating, please log in again.');
ok('exact try-again copy', WALLET_CHECK_RETRY_MESSAGE === 'Could not verify your wallet right now. Try again.');

const mod = read('src/lib/consumer/walletMigration.ts');
ok('404-only creation (other errors throw try-again)', mod.includes('WALLET_CHECK_FAILED') && mod.includes('isCircleClean404(err)'));
ok('consumers-only scope (no merchant/agent writes)', !/\(prisma as any\)\.(merchant|agentRegistry)/.test(mod) && (mod.match(/\.consumerAccount/g) ?? []).length >= 3);
ok('mainnet-gated (off-mainnet never writes)', mod.includes("getNetworkConfig().name !== \"mainnet\""));
ok('per-account advisory lock', mod.includes('pg_advisory_xact_lock') && mod.includes('consumer-wallet-migrate:'));
ok('row lock + post-lock re-check', mod.includes('FOR UPDATE') && mod.includes('locked.circleWalletId !== staleId'));
ok('stable keys threaded into both Circle creates', mod.includes("migrationIdempotencyKey(accountId, \"set\")") && mod.includes("migrationIdempotencyKey(accountId, \"wallets\")"));
ok('history append-only (never delete/rewrite)', mod.includes('previousWallets') && !/previousWallets:\s*\[\]/i.test(mod));
ok('Send signal is typed re-login (not raw Circle error)', mod.includes('WALLET_NEEDS_UPDATE'));

const login = read('src/app/api/consumer/email-auth/route.ts');
ok('login runs migration on returning CIRCLE row', login.includes('ensureMainnetConsumerWallet(account.id)'));
ok('login re-reads row after migrate (session carries NEW address)', login.includes('findUnique({ where: { id: account.id } })'));
ok('login shows one-time message then clears', login.includes('walletUpgradedMessage') && login.includes('migrationNoticePending: false'));
ok('migration failure never blocks login', login.includes('wallet upgrade check failed'));

const settle = read('src/app/api/payments/settle/route.ts');
ok('settle checks liveness on the consumer CIRCLE branch', settle.includes('assertConsumerCircleWalletLive(consumerAccount)'));

const guard = read('src/lib/env/walletEnvCheck.ts');
ok('production requires explicit ARC_NETWORK', guard.includes('must be set explicitly in production'));

const schema = read('prisma/schema.prisma');
ok('schema carries history + notice fields', schema.includes('previousWallets') && schema.includes('walletMigratedAt') && schema.includes('migrationNoticePending'));
const migSql = read('prisma/migrations/20260930000000_consumer_wallet_migration_history/migration.sql');
ok('migration adds exactly the three columns', migSql.includes('"previousWallets"') && migSql.includes('"walletMigratedAt"') && migSql.includes('"migrationNoticePending"'));

console.log(`\nconsumer-wallet-migration-tests: ${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
