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

const BASE: Record<string, string> = {
  SELLER_ADDRESS: '0xc119bb61dCd7Ce422557485ecD17D679f44250a1',
  SELLER_PRIVATE_KEY: '0x641115e797d1ae1d78db0bb81a4ec12cf91825c6021b92928f22d42e0f2a8fbb',
  BUYER_ADDRESS: '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44',
  BUYER_PRIVATE_KEY: '0x629c3dbd4a2b0699009bd19e0d0da29744f31e405d7476e00eb80240944a0663',
  EOA_PRIVATE_KEY: '0x629c3dbd4a2b0699009bd19e0d0da29744f31e405d7476e00eb80240944a0663',
  RELAYER_PRIVATE_KEY: '0x629c3dbd4a2b0699009bd19e0d0da29744f31e405d7476e00eb80240944a0663',
  ARC_ADMIN_PRIVATE_KEY: '0x629c3dbd4a2b0699009bd19e0d0da29744f31e405d7476e00eb80240944a0663',
  ESCROW_ADMIN_PRIVATE_KEY: '0x629c3dbd4a2b0699009bd19e0d0da29744f31e405d7476e00eb80240944a0663',
  PRIVATE_KEY: '0x629c3dbd4a2b0699009bd19e0d0da29744f31e405d7476e00eb80240944a0663',
  AGENT_OWNER_WALLET_ADDRESS: '0x7cf8ee2ab9c1aeb9cbae26511fb0cbda923ab15e',
  AGENT_VALIDATOR_WALLET_ADDRESS: '0xc3b50563e496a4e75a99dc45e4011d977032bb14',
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
expectFail('BUYER key/address mismatch rejected', { ...BASE, BUYER_PRIVATE_KEY: '0x641115e797d1ae1d78db0bb81a4ec12cf91825c6021b92928f22d42e0f2a8fbb' }, 'does not match');
expectFail('placeholder key rejected', { ...BASE, PRIVATE_KEY: 'YOUR_DEPLOYER_PRIVATE_KEY' }, 'placeholder');
expectFail('malformed key rejected', { ...BASE, RELAYER_PRIVATE_KEY: '0x1234' }, 'RELAYER_PRIVATE_KEY');
expectFail('missing key-only var rejected', { ...BASE, ESCROW_ADMIN_PRIVATE_KEY: undefined }, 'ESCROW_ADMIN_PRIVATE_KEY');
expectFail('bad custody address format rejected', { ...BASE, AGENT_OWNER_WALLET_ADDRESS: 'not-an-address' }, 'AGENT_OWNER_WALLET_ADDRESS');

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
