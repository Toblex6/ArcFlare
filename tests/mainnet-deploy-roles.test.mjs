// tests/mainnet-deploy-roles.test.mjs
//
// P1-1 regression: mainnet deployment role guards.
//
// Proves a mismatched role CANNOT be deployed on mainnet (chain 5042):
//   - exact production allowlist enforced for every role
//   - owner == relayer explicitly rejected
//   - known testnet role addresses rejected (the 0x62Ca…fA4fA failure mode)
//   - both deploy scripts actually invoke the guard on the mainnet path
//
// Pure/static only: no hardhat, no chain, no funds.
// Run: node --test tests/mainnet-deploy-roles.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MAINNET_PRODUCTION_ROLES,
  KNOWN_TESTNET_ROLE_ADDRESSES,
  assertMainnetJobEscrowRoles,
  assertMainnetPayrollRoles,
} from '../scripts/mainnet-roles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const GOOD_ESCROW = {
  owner: MAINNET_PRODUCTION_ROLES.owner,
  arbiter: MAINNET_PRODUCTION_ROLES.arbiter,
  treasurySink: MAINNET_PRODUCTION_ROLES.treasurySink,
  relayer: MAINNET_PRODUCTION_ROLES.relayer,
  spendLimitOwner: MAINNET_PRODUCTION_ROLES.owner,
  spendLimitRecorder: MAINNET_PRODUCTION_ROLES.relayer,
};
const GOOD_PAYROLL = {
  owner: MAINNET_PRODUCTION_ROLES.owner,
  relayer: MAINNET_PRODUCTION_ROLES.relayer,
};

// ── 1. Exact production roles pass ───────────────────────────────────────────
test('exact production roles pass (job escrow + payroll)', () => {
  assert.doesNotThrow(() => assertMainnetJobEscrowRoles(GOOD_ESCROW));
  assert.doesNotThrow(() => assertMainnetPayrollRoles(GOOD_PAYROLL));
});

// ── 2. Any single mismatch is rejected ───────────────────────────────────────
test('any single mismatched role is rejected on mainnet', () => {
  const attacker = '0xDeaDbeefdEAdbeefdEadbeefdEadbeefdEadbeef';
  for (const key of Object.keys(GOOD_ESCROW)) {
    assert.throws(
      () => assertMainnetJobEscrowRoles({ ...GOOD_ESCROW, [key]: attacker }),
      /does not match the production/,
      `escrow role ${key} mismatch must throw`
    );
  }
  for (const key of Object.keys(GOOD_PAYROLL)) {
    assert.throws(
      () => assertMainnetPayrollRoles({ ...GOOD_PAYROLL, [key]: attacker }),
      /does not match the production/,
      `payroll role ${key} mismatch must throw`
    );
  }
});

// ── 3. owner == relayer explicitly rejected ──────────────────────────────────
test('owner == relayer is explicitly rejected', () => {
  assert.throws(
    () =>
      assertMainnetJobEscrowRoles({
        ...GOOD_ESCROW,
        owner: GOOD_ESCROW.relayer,
        spendLimitOwner: GOOD_ESCROW.relayer,
      }),
    /must not equal/,
    'escrow owner==relayer must throw the explicit error'
  );
  assert.throws(
    () => assertMainnetPayrollRoles({ owner: GOOD_PAYROLL.relayer, relayer: GOOD_PAYROLL.relayer }),
    /must not equal/,
    'payroll owner==relayer must throw the explicit error'
  );
  // Also when both equal the Safe (allowlist-shaped but same key).
  assert.throws(
    () => assertMainnetPayrollRoles({ owner: GOOD_PAYROLL.owner, relayer: GOOD_PAYROLL.owner }),
    /must not equal/
  );
});

// ── 4. Known testnet addresses rejected (the 0x62Ca… failure mode) ───────────
test('known testnet role addresses are rejected on mainnet', () => {
  assert.ok(KNOWN_TESTNET_ROLE_ADDRESSES.length >= 5, 'denylist must cover the known testnet identities');
  for (const testnetAddr of KNOWN_TESTNET_ROLE_ADDRESSES) {
    assert.throws(
      () => assertMainnetJobEscrowRoles({ ...GOOD_ESCROW, owner: testnetAddr }),
      /KNOWN TESTNET/,
      `${testnetAddr} as escrow owner must throw the testnet error`
    );
    assert.throws(
      () => assertMainnetPayrollRoles({ ...GOOD_PAYROLL, relayer: testnetAddr }),
      /KNOWN TESTNET/,
      `${testnetAddr} as payroll relayer must throw the testnet error`
    );
  }
  // The abandoned deployment shape: owner=recorder=testnet relayer.
  assert.throws(() =>
    assertMainnetJobEscrowRoles({
      ...GOOD_ESCROW,
      owner: '0x03badcdb102433798df5feb854b87c7a37dde3a6',
      spendLimitOwner: '0x03badcdb102433798df5feb854b87c7a37dde3a6',
    })
  );
  // The compromised (retired 2026-09-18) testnet relayer key is denied too.
  assert.throws(() =>
    assertMainnetJobEscrowRoles({
      ...GOOD_ESCROW,
      relayer: '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44',
      spendLimitRecorder: '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44',
    })
  );
});

// ── 5. Case-insensitive exact match (checksummed vs lowercase) ───────────────
test('allowlist comparison is case-insensitive but otherwise exact', () => {
  assert.doesNotThrow(() =>
    assertMainnetPayrollRoles({
      owner: GOOD_PAYROLL.owner.toLowerCase(),
      relayer: GOOD_PAYROLL.relayer.toUpperCase(),
    })
  );
  // Near-miss values are not "exact": flip the last hex char.
  const nearMiss = `${GOOD_PAYROLL.owner.slice(0, -1)}${GOOD_PAYROLL.owner.endsWith('4') ? '5' : '4'}`;
  assert.notEqual(nearMiss.toLowerCase(), GOOD_PAYROLL.owner.toLowerCase());
  assert.throws(() => assertMainnetPayrollRoles({ ...GOOD_PAYROLL, owner: nearMiss }));
});

// ── 6. Missing roles rejected ────────────────────────────────────────────────
test('missing roles are rejected', () => {
  assert.throws(() => assertMainnetJobEscrowRoles({ ...GOOD_ESCROW, arbiter: '' }), /not set/);
  assert.throws(() => assertMainnetPayrollRoles({ ...GOOD_PAYROLL, owner: undefined }), /not set/);
});

// ── 7. Both deploy scripts invoke the guard on the mainnet path ─────────────
test('deploy scripts enforce the allowlist on the mainnet path only', () => {
  const arcflare = read('scripts/deploy-arcflare.mjs');
  assert.match(arcflare, /from ["']\.\/mainnet-roles\.mjs["']/);
  assert.match(arcflare, /if \(isMainnet\) \{\s*\n?\s*assertMainnetJobEscrowRoles/);
  const payroll = read('scripts/deploy-payroll.mjs');
  assert.match(payroll, /from ["']\.\/mainnet-roles\.mjs["']/);
  assert.match(payroll, /if \(isMainnet\) \{\s*\n?\s*assertMainnetPayrollRoles/);
  // No testnet-path gating: the guard identifier appears only inside isMainnet.
  for (const [name, src] of [['deploy-arcflare.mjs', arcflare], ['deploy-payroll.mjs', payroll]]) {
    const occurrences = src.split('assertMainnet').length - 1;
    assert.ok(occurrences >= 2, `${name} must reference the guard (import + call)`);
  }
});
