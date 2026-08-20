// scripts/test-wallet-env-validation.ts
//
// Fail-closed env validation tests: deliberately misconfigured wallet/key
// pairs must fail with a clear error, and the real merged env must pass.
//
// Run:  npx tsx scripts/test-wallet-env-validation.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { validateWalletEnv, assertWalletEnv } from '@/lib/env/walletEnvCheck';

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Fixtures use the standard Hardhat/Anvil accounts #0 and #1 — universally
// published throwaway keys that control nothing. This file previously held the
// REAL SELLER_PRIVATE_KEY and RELAYER/ADMIN key and is committed to a public
// repo; those keys were exposed and must be treated as compromised (2026-08-20).
// Never paste a live key here: validateWalletEnv only needs internally
// consistent pairs, and it never touches the network.
const BASE: Record<string, string> = {
  SELLER_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  SELLER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  BUYER_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  BUYER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  EOA_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  RELAYER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ARC_ADMIN_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ESCROW_ADMIN_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  AGENT_OWNER_WALLET_ADDRESS: '0x7cf8ee2ab9c1aeb9cbae26511fb0cbda923ab15e',
  AGENT_VALIDATOR_WALLET_ADDRESS: '0xc3b50563e496a4e75a99dc45e4011d977032bb14',
  // M10 required secrets (throwaway, ≥ minLen): the validator only checks
  // presence/length/placeholder — it never touches these, so fake-but-valid is fine.
  X402_WALLET_ENCRYPTION_KEY: 'x402-test-encryption-key-0123456789abcdef-0123456789',
  CONSUMER_JWT_SECRET: 'consumer-jwt-test-secret-0123456789abcdef-0123456789',
  MERCHANT_JWT_SECRET: 'merchant-jwt-test-secret-0123456789abcdef-0123456789',
  INTERNAL_SETTLEMENT_API_KEY: 'test-internal-key-0123456789abcdef',
  TELEGRAM_BOT_TOKEN: 'test-telegram-bot-token-0123456789abcdef-0123456789',
  TELEGRAM_WEBHOOK_SECRET: 'test-telegram-hmac-0123456789abcdef',
  // M10 required contract addresses (0x40 format).
  PAYROLL_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
  SPEND_LIMIT_CONTRACT_ADDRESS: '0x2222222222222222222222222222222222222222',
  SWAP_POOL_CONTRACT_ADDRESS: '0x3333333333333333333333333333333333333333',
  JOB_ESCROW_CONTRACT_ADDRESS: '0x4444444444444444444444444444444444444444',
  // M10 Circle creds (throwaway, ≥ 16 chars).
  CIRCLE_API_KEY: 'test-circle-api-key-0123456789',
  CIRCLE_WALLET_SET_ID: 'test-circle-wallet-set-0123456789',
  CIRCLE_ENTITY_SECRET: 'test-circle-entity-secret-0123456789',
};

function expectFail(label: string, env: Record<string, string | undefined>, needle: string) {
  const result = validateWalletEnv(env);
  ok(label, !result.ok && result.errors.some((e) => e.includes(needle)),
    result.ok ? 'did NOT fail' : result.errors[0].slice(0, 90));
}

console.log('Negative cases (must fail closed):');
expectFail('SELLER_WALLET_ADDRESS (legacy, no key) rejected',
  { ...BASE, SELLER_WALLET_ADDRESS: '0xa8d1d91384f2ab2edab9a58213b15635bf85c7f6' }, 'deprecated');
expectFail('missing SELLER_PRIVATE_KEY rejected', { ...BASE, SELLER_PRIVATE_KEY: undefined }, 'SELLER_PRIVATE_KEY');
expectFail('BUYER key/address mismatch rejected', { ...BASE, BUYER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' }, 'does not match');
expectFail('placeholder key rejected', { ...BASE, PRIVATE_KEY: 'YOUR_DEPLOYER_PRIVATE_KEY' }, 'placeholder');
expectFail('malformed key rejected', { ...BASE, RELAYER_PRIVATE_KEY: '0x1234' }, 'RELAYER_PRIVATE_KEY');
expectFail('missing key-only var rejected', { ...BASE, ESCROW_ADMIN_PRIVATE_KEY: undefined }, 'ESCROW_ADMIN_PRIVATE_KEY');
expectFail('bad custody address format rejected', { ...BASE, AGENT_OWNER_WALLET_ADDRESS: 'not-an-address' }, 'AGENT_OWNER_WALLET_ADDRESS');
expectFail('missing X402_WALLET_ENCRYPTION_KEY rejected', { ...BASE, X402_WALLET_ENCRYPTION_KEY: undefined }, 'X402_WALLET_ENCRYPTION_KEY');
expectFail('short INTERNAL_SETTLEMENT_API_KEY rejected', { ...BASE, INTERNAL_SETTLEMENT_API_KEY: 'short' }, 'INTERNAL_SETTLEMENT_API_KEY');
expectFail('missing PAYROLL_CONTRACT_ADDRESS rejected', { ...BASE, PAYROLL_CONTRACT_ADDRESS: undefined }, 'PAYROLL_CONTRACT_ADDRESS');
expectFail('bad contract address format rejected', { ...BASE, SWAP_POOL_CONTRACT_ADDRESS: '0x123' }, 'SWAP_POOL_CONTRACT_ADDRESS');
expectFail('malformed allowlist entry rejected', { ...BASE, SELLER_GATEWAY_TREASURY_ADDRESSES: '0xzzzz' }, 'SELLER_GATEWAY_TREASURY_ADDRESSES');
expectFail('missing CIRCLE_API_KEY rejected', { ...BASE, CIRCLE_API_KEY: undefined }, 'CIRCLE_API_KEY');

console.log('Positive case (clean base):');
const clean = validateWalletEnv(BASE);
ok('clean config passes', clean.ok, clean.errors.join('; ').slice(0, 80));

console.log('Real merged env (.env + .env.local):');
try {
  assertWalletEnv();
  ok('real env passes startup validation', true);
} catch (e: any) {
  ok('real env passes startup validation', false, (e?.message ?? '').slice(0, 160));
}

console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
if (fail > 0) process.exit(1);
