// tests/deploy-persistence.test.mjs — wallet-set / validator-SCA persistence regression tests.
//
// Scope: prisma/schema.prisma (AgentRegistry.walletSetId/validatorSca),
// src/app/api/agent/deploy/route.ts persistence block, and the additive migration.
// Run: node --test tests/deploy-persistence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, '..', 'src', 'app', 'api', 'agent', 'deploy', 'route.ts');
const SCHEMA_PATH = path.join(here, '..', 'prisma', 'schema.prisma');
const MIGRATION_SQL_PATH = path.join(
  here,
  '..',
  'prisma',
  'migrations',
  '20260905000000_add_agent_registry_wallet_set_validator',
  'migration.sql'
);

const src = readFileSync(ROUTE_PATH, 'utf8');
const schema = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

const agentRegistryBlock = schema.slice(
  schema.indexOf('model AgentRegistry {'),
  schema.indexOf('model ApiListing {')
);

test('schema: AgentRegistry gains nullable walletSetId + validatorSca', () => {
  assert.ok(/^\s*walletSetId\s+String\?\s*$/m.test(agentRegistryBlock), 'walletSetId String? must exist');
  assert.ok(/^\s*validatorSca\s+String\?\s*$/m.test(agentRegistryBlock), 'validatorSca String? must exist');
});

test('schema: no existing AgentRegistry fields are dropped or changed', () => {
  for (const field of [
    'name           String',
    'tokenId        String               @unique',
    'scaAddress     String               @unique',
    'circleWalletId String?',
    'ownerNode      String',
    'metadataURI    String?',
    'description    String?',
    'skills         Json?',
    'pricing        Json?',
    'reputation     Int                  @default(50)',
    'idempotencyKey String?              @unique',
    'merchantId     String?',
  ]) {
    assert.ok(agentRegistryBlock.includes(field), `existing field must be unchanged: ${field}`);
  }
  // No second copy of the new fields leaked onto another model (e.g. ConsumerAccount).
  const walletSetIdCount = (schema.match(/^\s*walletSetId\s+String\?/gm) || []).length;
  assert.equal(walletSetIdCount, 2, 'exactly two nullable walletSetId decls expected (AgentRegistry + ConsumerAccount)');
});

test('route: deploy persists walletSetId + validatorSca from authoritative flow values', () => {
  const createIdx = src.indexOf('agentRegistry.create');
  assert.ok(createIdx !== -1, 'agentRegistry.create must still exist');
  const persistBlock = src.slice(createIdx, createIdx + 900);
  assert.ok(persistBlock.includes('walletSetId: walletSetId'), 'must persist walletSetId from the provisioned wallet set');
  assert.ok(persistBlock.includes('validatorSca: validatorWallet.address'), 'must persist validatorSca from the provisioned validator wallet');
  // Authoritative sources unchanged: walletSetId comes from createWalletSet, validator from the 2-wallet batch.
  assert.ok(src.includes('createWalletSet'), 'wallet-set provisioning must be unchanged');
  assert.ok(src.includes('count: 2'), 'two-wallet (owner + validator) provisioning must be unchanged');
  assert.ok(src.includes('const walletSetId = walletSet.data?.walletSet?.id'), 'walletSetId source must be unchanged');
});

test('route: existing deployment identity behavior is unchanged', () => {
  assert.ok(src.includes("abiFunctionSignature: 'register(string)'"), 'ERC-8004 register call must be unchanged');
  assert.ok(src.includes("status: 'ACTIVE_AGENT_PROVISIONED'"), 'ACTIVE status must be unchanged');
  assert.ok(src.includes('tokenId: tokenId'), 'real tokenId persistence must be unchanged');
  const guardIdx = src.indexOf('if (!tokenId)');
  const createIdx = src.indexOf('agentRegistry.create');
  assert.ok(guardIdx !== -1 && guardIdx < createIdx, 'fail-closed missing-log guard must still precede persistence');
  assert.ok(!src.includes('ERC8004-FALLBACK') && !src.includes('FALLBACK-'), 'no fallback identity may be introduced');
  // No default-payer / shared-wallet fallback introduced.
  assert.ok(!/ownerWallet\s*\|\|\s*\w/.test(src), 'no fallback wallet substitution may be introduced');
});

test('migration: additive-only, nullable columns, no unrelated changes', () => {
  assert.ok(migrationSql.includes('ADD COLUMN'), 'must add columns');
  assert.ok(migrationSql.includes('"walletSetId"'), 'must add walletSetId');
  assert.ok(migrationSql.includes('"validatorSca"'), 'must add validatorSca');
  assert.ok(migrationSql.includes('"AgentRegistry"'), 'must target AgentRegistry only');
  for (const banned of ['DROP TABLE', 'DROP COLUMN', 'SET NOT NULL', 'NOT NULL', 'UPDATE ', 'DELETE ', 'CREATE TABLE', 'ALTER COLUMN']) {
    assert.ok(!migrationSql.includes(banned), `migration must not contain: ${banned}`);
  }
  const otherTables = (migrationSql.match(/ALTER TABLE "(?!AgentRegistry)\w+"/g) || []);
  assert.deepEqual(otherTables, [], 'no unrelated tables may be touched');
});

// ── Live persistence proofs (Neon dev; rows are created + deleted, existing data untouched) ──
const { PrismaClient } = await import('@prisma/client');

function uniqueHex(prefix) {
  return `${prefix}${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`.slice(0, 42).padEnd(42, '0');
}

test('live: newly created AgentRegistry row persists walletSetId + validatorSca', async () => {
  const prisma = new PrismaClient();
  const tokenId = `test-persist-${Date.now()}`;
  let id = null;
  try {
    const created = await prisma.agentRegistry.create({
      data: {
        name: 'persistence-test-agent',
        tokenId,
        scaAddress: uniqueHex('0xt1'),
        ownerNode: 'test-node',
        status: 'ACTIVE_AGENT_PROVISIONED',
        walletSetId: 'test-wallet-set-id',
        validatorSca: uniqueHex('0xv1'),
      },
    });
    id = created.id;
    assert.equal(created.walletSetId, 'test-wallet-set-id');
    assert.ok(created.validatorSca && created.validatorSca.startsWith('0xv1'));
    const reread = await prisma.agentRegistry.findUnique({ where: { tokenId } });
    assert.equal(reread.walletSetId, 'test-wallet-set-id');
    assert.equal(reread.validatorSca, created.validatorSca);
  } finally {
    if (id !== null) await prisma.agentRegistry.delete({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  }
});

test('live: walletSetId + validatorSca may remain null (older/edge rows)', async () => {
  const prisma = new PrismaClient();
  const tokenId = `test-null-${Date.now()}`;
  let id = null;
  try {
    const created = await prisma.agentRegistry.create({
      data: {
        name: 'legacy-style-agent',
        tokenId,
        scaAddress: uniqueHex('0xt2'),
        ownerNode: 'test-node',
        status: 'ACTIVE_AGENT_PROVISIONED',
      },
    });
    id = created.id;
    assert.equal(created.walletSetId, null);
    assert.equal(created.validatorSca, null);
  } finally {
    if (id !== null) await prisma.agentRegistry.delete({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
