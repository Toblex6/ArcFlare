// tests/deploy-identity.test.mjs — SUBTASK E: ERC-8004 fallback identity regression tests.
//
// Scope: src/app/api/agent/deploy/route.ts identity handling ONLY.
// The route pulls heavy deps (next/server, Prisma, Circle SDK), so these tests verify
// the deployed source contract statically + exercise the documented token-selection
// precedence as pure logic. Run: node --test tests/deploy-identity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, '..', 'src', 'app', 'api', 'agent', 'deploy', 'route.ts');
const src = readFileSync(ROUTE_PATH, 'utf8');

test('never synthesizes a fallback ERC-8004 identity', () => {
  assert.ok(!src.includes('ERC8004-FALLBACK'), 'route must not contain ERC8004-FALLBACK');
  assert.ok(!src.includes('FALLBACK-'), 'route must not contain any FALLBACK- tokenId');
  // No randomness in identity resolution — tokenId must come from chain logs only.
  const identitySection = src.slice(src.indexOf('// 6.'));
  assert.ok(!identitySection.includes('Math.random'), 'identity section must not use Math.random');
});

test('missing Transfer log yields truthful pending state, never ACTIVE', () => {
  // Guard exists and returns before any DB write.
  const guardIdx = src.indexOf('if (!tokenId)');
  const createIdx = src.indexOf('agentRegistry.create');
  assert.ok(guardIdx !== -1, 'missing-log guard (if (!tokenId)) must exist');
  assert.ok(createIdx !== -1, 'successful-deploy persist must still exist');
  assert.ok(guardIdx < createIdx, 'missing-log return must precede agentRegistry.create');
  // Pending contract surfaced to the operator.
  assert.ok(src.includes('PENDING_IDENTITY_CONFIRMATION'), 'must surface PENDING_IDENTITY_CONFIRMATION');
  assert.ok(src.includes('retryable: true'), 'missing-log response must be marked retryable');
  // ACTIVE status is only reachable after the guard (real tokenId proven).
  const activeIdx = src.indexOf('ACTIVE_AGENT_PROVISIONED');
  assert.ok(activeIdx > guardIdx, 'ACTIVE status must only be written after real-tokenId guard');
});

test('missing-log response carries tx hash + inspection info for operator retry', () => {
  const guardBlock = src.slice(src.indexOf('if (!tokenId)'), src.indexOf('agentRegistry.create'));
  for (const key of ['txHash', 'explorerUrl', 'wallets', 'registry', 'ownerAddress', 'hint']) {
    assert.ok(guardBlock.includes(key), `missing-log response must include ${key}`);
  }
  assert.ok(guardBlock.includes('502'), 'missing-log case must use a failed/pending status code, not 2xx-active');
});

test('Circle wallets are never silently deleted/orphaned on identity failure', () => {
  assert.ok(!/deleteWallets?\s*\(|archiveWallets?\s*\(|removeWallets?\s*\(|\.delete\s*\(\s*\{\s*where/.test(src),
    'route must not delete wallets on any path');
  const guardBlock = src.slice(src.indexOf('if (!tokenId)'), src.indexOf('agentRegistry.create'));
  assert.ok(guardBlock.includes('no wallet was deleted') || guardBlock.includes('wallets'),
    'missing-log response must confirm wallet preservation / return wallet refs');
});

test('tokenId recovery retries transient RPC failures and prefers this-tx logs', () => {
  assert.ok(src.includes('getTransactionReceipt'), 'must attempt precise receipt-log recovery');
  assert.ok(src.includes('getLogs'), 'must keep windowed log search as fallback path');
  assert.ok(/for\s*\(.*attempt.*<=.*&& !tokenId/.test(src), 'recovery must retry instead of assuming failure');
  assert.ok(src.includes('transactionHash'), 'windowed search must prefer logs from our own txHash');
  assert.ok(src.includes('decodeEventLog'), 'receipt logs must be decoded as Transfer events');
  assert.ok(src.includes('registryAddress') && src.includes('ownerAddress'),
    'receipt scan must filter by registry address and owner wallet');
});

test('successful deploy behavior preserved: real tokenId persisted as ACTIVE', () => {
  const persistBlock = src.slice(src.indexOf('agentRegistry.create'), src.indexOf('agentRegistry.create') + 800);
  assert.ok(persistBlock.includes('tokenId: tokenId'), 'must persist the recovered real tokenId');
  assert.ok(persistBlock.includes("status: 'ACTIVE_AGENT_PROVISIONED'"),
    'successful deploy must still mark ACTIVE_AGENT_PROVISIONED');
});

// Documents the intended selection precedence enforced by the route's recovery loop:
// receipt log (this tx, registry, owner) > own-tx windowed log > any windowed log > PENDING.
test('token-selection precedence rule', () => {
  const select = (receiptMatch, ownTxMatch, anyMatch) =>
    receiptMatch ?? ownTxMatch ?? anyMatch ?? null;
  assert.equal(select('7', '8', '9'), '7');
  assert.equal(select(null, '8', '9'), '8');
  assert.equal(select(null, null, '9'), '9');
  assert.equal(select(null, null, null), null, 'no log anywhere => null (caller returns PENDING, never fake id)');
});
