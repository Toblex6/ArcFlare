// tests/mainnet-escrow-deployer-key.test.mjs
//
// Focused regression: the escrow deploy script must validate
// MAINNET_DEPLOYER_KEY during read-only preflight too, reporting
// keyAddressMatches: true only for the pinned MAINNET_ESCROW_DEPLOYER.
//
// Pure/offline: deterministic throwaway keys, no RPC, no transactions, no funds.
// Run: node --test tests/mainnet-escrow-deployer-key.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Wallet } from 'ethers';

import {
  DEPLOYER_KEY_INVALID,
  DEPLOYER_KEY_MISMATCH,
  resolveMainnetDeployerKey,
} from '../scripts/lib/mainnet-deployer-key.mjs';
import { MAINNET_ESCROW_DEPLOYER } from '../scripts/mainnet-roles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const KEY = '0x' + '11'.repeat(32); // throwaway fixture, no funds
const OTHER_KEY = '0x' + '22'.repeat(32);
const ADDRESS = new Wallet(KEY).address;
const OTHER_ADDRESS = new Wallet(OTHER_KEY).address;

test('matching key derives its address and reports keyAddressMatches: true', () => {
  const resolved = resolveMainnetDeployerKey(KEY, ADDRESS);
  assert.equal(resolved.keyAddressMatches, true);
  assert.equal(resolved.deployer, ADDRESS);
  assert.equal(resolved.signer.address, ADDRESS);
  // Allowlist comparison is case-insensitive (checksummed vs lowercase).
  assert.equal(resolveMainnetDeployerKey(KEY, ADDRESS.toLowerCase()).keyAddressMatches, true);
  // 64 hex chars without the 0x prefix is accepted, matching the old format check.
  assert.equal(resolveMainnetDeployerKey(KEY.slice(2), ADDRESS).keyAddressMatches, true);
});

test('mismatching key fails closed before any deployment step', () => {
  assert.throws(() => resolveMainnetDeployerKey(KEY, OTHER_ADDRESS), (error) => {
    assert.equal(error.message, DEPLOYER_KEY_MISMATCH);
    assert.ok(!error.message.includes(KEY.slice(2)));
    return true;
  });
  // A throwaway key can never satisfy the pinned production deployer.
  assert.throws(() => resolveMainnetDeployerKey(KEY, MAINNET_ESCROW_DEPLOYER), /does not match MAINNET_ESCROW_DEPLOYER/);
});

test('absent key keeps read-only preflight non-failing with null', () => {
  for (const rawKey of [undefined, '']) {
    const resolved = resolveMainnetDeployerKey(rawKey, MAINNET_ESCROW_DEPLOYER);
    assert.equal(resolved.keyAddressMatches, null);
    assert.equal(resolved.signer, null);
    assert.equal(resolved.deployer, MAINNET_ESCROW_DEPLOYER);
  }
});

test('invalid key formats are rejected without echoing the value', () => {
  for (const rawKey of ['0x1234', 'not-a-key', `0x${'11'.repeat(33)}`, `0x${'11'.repeat(32)}zz`, '0x' + '00'.repeat(32)]) {
    assert.throws(() => resolveMainnetDeployerKey(rawKey, ADDRESS), (error) => {
      assert.equal(error.message, DEPLOYER_KEY_INVALID);
      assert.ok(!error.message.includes(rawKey));
      return true;
    });
  }
});

test('resolution never logs key material', () => {
  const calls = [];
  const { log, error } = console;
  console.log = (...args) => calls.push(args);
  console.error = (...args) => calls.push(args);
  try {
    resolveMainnetDeployerKey(KEY, ADDRESS);
    assert.throws(() => resolveMainnetDeployerKey(OTHER_KEY, ADDRESS));
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.deepEqual(calls, []);
});

test('deploy script validates the key on the read-only path and keeps broadcasting execute-only', () => {
  const deploy = read('scripts/deploy-flarehq-escrow.mjs');
  assert.match(deploy, /const rawKey = process\.env\.MAINNET_DEPLOYER_KEY;/);
  assert.match(deploy, /resolveMainnetDeployerKey\(rawKey, MAINNET_ESCROW_DEPLOYER\)/);
  assert.match(deploy, /\n\s*keyAddressMatches,/);
  assert.ok(!/console\.[a-z]+\([^)]*rawKey/.test(deploy), 'the raw key must never be logged');
  const gate = deploy.indexOf('if (!execute || name !== escrow) continue;');
  const send = deploy.indexOf('signerOnMainnet.sendTransaction(');
  assert.ok(gate > 0 && send > gate, 'broadcast must stay behind the --execute gate');
  assert.match(deploy.slice(gate, send), /checkDeploymentRevision\(source, reviewed\)/);
});
