// tests/deploy-intent.test.mjs — AgentDeployIntent deploy-intent persistence + recovery security tests.
//
// Scope:
//   * prisma/schema.prisma (AgentDeployIntent model)
//   * prisma/migrations/20260905020000_add_agent_deploy_intent/migration.sql
//   * src/app/api/agent/deploy/route.ts (deploy-intent write + status transitions)
//   * src/app/api/agent/deploy/recover/route.ts (deploy-intent-bound recovery)
//
// The recovery endpoint's heavy deps (next/server, Prisma, viem, Circle SDK)
// make live HTTP testing impractical, so — following tests/deploy-identity and
// tests/deploy-persistence conventions — the endpoint proofs here are static
// source-ordering/security proofs, plus a small live AgentDeployIntent row test
// (Neon dev; row created + deleted, existing data untouched).
// Run: node --test tests/deploy-intent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', 'prisma', 'schema.prisma');
const MIGRATION_SQL_PATH = path.join(
  here,
  '..',
  'prisma',
  'migrations',
  '20260905020000_add_agent_deploy_intent',
  'migration.sql'
);
const DEPLOY_ROUTE = path.join(here, '..', 'src', 'app', 'api', 'agent', 'deploy', 'route.ts');
const RECOVER_ROUTE = path.join(here, '..', 'src', 'app', 'api', 'agent', 'deploy', 'recover', 'route.ts');
const CONTROLS = path.join(here, '..', 'src', 'lib', 'wallet', 'verifyCallerControlsAddress.ts');

const schema = readFileSync(SCHEMA_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf8');
const deploySrc = readFileSync(DEPLOY_ROUTE, 'utf8');
const recoverSrc = readFileSync(RECOVER_ROUTE, 'utf8');
const controlsSrc = readFileSync(CONTROLS, 'utf8');

const intentBlock = schema.slice(
  schema.indexOf('model AgentDeployIntent {'),
  schema.indexOf('model ApiListing {')
);

// ── Schema ───────────────────────────────────────────────────────────────────
test('schema: AgentDeployIntent model exists with the minimal authoritative fields', () => {
  assert.ok(intentBlock.includes('model AgentDeployIntent {'), 'model must exist');
  for (const field of [
    'id             String    @id @default(uuid())',
    'merchantId     String',
    'walletSetId    String    @unique',
    'ownerSca       String',
    'validatorSca   String',
    'circleWalletId String?',
    'idempotencyKey String?',
    'status         String    @default("PROVISIONING")',
    'registerTxHash String?',
    'createdAt      DateTime  @default(now())',
    'updatedAt      DateTime  @default(now()) @updatedAt',
    '@@unique([merchantId, idempotencyKey])',
    '@@index([merchantId, status])',
    '@@index([registerTxHash])',
  ]) {
    assert.ok(intentBlock.includes(field), `intent must carry: ${field}`);
  }
});

test('schema: AgentRegistry untouched (new model is purely additive)', () => {
  const agentRegistryBlock = schema.slice(
    schema.indexOf('model AgentRegistry {'),
    schema.indexOf('model AgentDeployIntent {')
  );
  for (const field of [
    'tokenId        String               @unique',
    'scaAddress     String               @unique',
    'walletSetId    String?',
    'validatorSca   String?',
    'merchantId     String?',
    'idempotencyKey String?              @unique',
  ]) {
    assert.ok(agentRegistryBlock.includes(field), `AgentRegistry field unchanged: ${field}`);
  }
});

// ── Migration ─────────────────────────────────────────────────────────────────
test('migration: additive-only, new table, no unrelated table/column changes', () => {
  assert.ok(migrationSql.includes('CREATE TABLE "AgentDeployIntent"'), 'must create AgentDeployIntent');
  assert.ok(migrationSql.includes('"walletSetId" TEXT NOT NULL'), 'walletSetId required');
  assert.ok(migrationSql.includes('"ownerSca" TEXT NOT NULL'), 'ownerSca required');
  assert.ok(migrationSql.includes('"validatorSca" TEXT NOT NULL'), 'validatorSca required');
  assert.ok(migrationSql.includes("'PROVISIONING'"), 'default status PROVISIONING');
  for (const banned of ['DROP TABLE', 'DROP COLUMN', 'SET NOT NULL', 'UPDATE ', 'DELETE FROM', 'ALTER COLUMN']) {
    assert.ok(!migrationSql.includes(banned), `migration must not contain: ${banned}`);
  }
  const otherTables = (migrationSql.match(/ALTER TABLE "(?!AgentDeployIntent)\w+"/g) || []);
  assert.deepEqual(otherTables, [], 'no unrelated table may be altered');
  assert.ok(migrationSql.includes('CREATE UNIQUE INDEX "AgentDeployIntent_walletSetId_key"'),
    'walletSetId must be globally unique (one intent per wallet set)');
  assert.ok(migrationSql.includes('CREATE UNIQUE INDEX "AgentDeployIntent_merchantId_idempotencyKey_key"'),
    'merchant + idempotency key must be unique');
});

// ── Deploy route: intent is persisted BEFORE the register, server-derived ────
test('deploy route: deploy intent is created after wallet provisioning and BEFORE the ERC-8004 register', () => {
  const idxWallets = deploySrc.indexOf('createWallets');
  const idxIntent = deploySrc.indexOf('agentDeployIntent.create');
  const idxRegister = deploySrc.indexOf('createContractExecutionTransaction');
  assert.ok(idxWallets !== -1 && idxIntent !== -1 && idxRegister !== -1, 'all anchors present');
  assert.ok(idxWallets < idxIntent, 'intent must be persisted AFTER wallets exist');
  assert.ok(idxIntent < idxRegister, 'intent must be persisted BEFORE the register tx');
});

test('deploy route: intent binds only SERVER-derived values to the authenticated merchant', () => {
  const intentCreateBlock = deploySrc.slice(
    deploySrc.indexOf('agentDeployIntent.create'),
    deploySrc.indexOf('agentDeployIntent.create') + 900
  );
  assert.ok(intentCreateBlock.includes('merchantId: merchant.id'), 'merchantId from auth, never body');
  assert.ok(intentCreateBlock.includes('walletSetId: walletSetId'), 'walletSetId from Circle response');
  assert.ok(intentCreateBlock.includes('ownerSca: ownerWallet.address'), 'ownerSca from Circle response');
  assert.ok(intentCreateBlock.includes('validatorSca: validatorWallet.address'), 'validatorSca from Circle response');
  assert.ok(intentCreateBlock.includes('status: \'PROVISIONING\''), 'initial status PROVISIONING');
  assert.ok(!intentCreateBlock.includes('body.walletSetId') && !intentCreateBlock.includes('body.merchantId'),
    'no client-supplied binding may be persisted');
});

test('deploy route: idempotency key is normalized and DB-deduped before provisioning', () => {
  assert.ok(deploySrc.includes('normalizeAgentDeployIdempotencyKey'), 'guard normalizer imported');
  assert.ok(deploySrc.includes('idempotencyKey: normalizedIdempotencyKey'), 'intent stores normalized key');
  const preflightIdx = deploySrc.indexOf('agentDeployIntent.findFirst');
  const createWalletSetIdx = deploySrc.indexOf('createWalletSet');
  assert.ok(preflightIdx !== -1 && preflightIdx < createWalletSetIdx,
    'DB-level duplicate intent check must run before a new Circle wallet set');
});

test('deploy route: status lifecycle transitions are present', () => {
  // txHash bound to the intent the moment Circle confirms it (before token extraction).
  const registerTxHashIdx = deploySrc.indexOf('markIntent({ registerTxHash: txHash })');
  const tokenExtractionIdx = deploySrc.indexOf('// 6. Indexing via Viem');
  assert.ok(registerTxHashIdx !== -1 && registerTxHashIdx < tokenExtractionIdx,
    'registerTxHash must be recorded before token extraction');
  // Token-extraction failure leaves a recoverable PENDING intent (no fake tokenId).
  const pendingIdx = deploySrc.indexOf("markIntent({ status: 'PENDING_IDENTITY_CONFIRMATION' })");
  const ifNoTokenIdx = deploySrc.indexOf('if (!tokenId)');
  assert.ok(pendingIdx !== -1 && pendingIdx > ifNoTokenIdx,
    'PENDING transition must sit inside the missing-tokenId guard');
  // Success marks the intent COMPLETED; revert/no-tx marks FAILED.
  assert.equal((deploySrc.match(/markIntent\(\{ status: 'COMPLETED' \}\)/g) || []).length, 2,
    'COMPLETED after normal create AND after P2002 replay');
  assert.ok(deploySrc.includes("status: 'FAILED'"), 'FAILED transition for reverted/never-submitted register');
  // The fail-closed guard still precedes any AgentRegistry persistence.
  assert.ok(ifNoTokenIdx < deploySrc.indexOf('agentRegistry.create'),
    'no AgentRegistry row may be written when tokenId is unknown');
});

test('deploy route: guard semantics unchanged and ownership gate not weakened', () => {
  assert.ok(deploySrc.includes('checkAgentDeployAllowed(merchant.id'), 'guard still keyed on auth merchant');
  assert.ok(!deploySrc.includes('checkAgentDeployAllowed(body'), 'guard never keyed on client input');
  assert.ok(!deploySrc.includes('verifyCallerControlsAddress'),
    'deploy route must not import the caller-control gate');
  assert.ok(!/ownerWallet\s*\|\|\s*\w/.test(deploySrc), 'no fallback wallet substitution');
  assert.ok(!deploySrc.includes('ERC8004-FALLBACK') && !deploySrc.includes('FALLBACK-'), 'no fallback identity');
});

// ── Recover route: ownership proven by the deploy intent, never the client ───
test('recover route: only txHash is accepted; no client ownership claim is ever read', () => {
  assert.ok(recoverSrc.includes('withMerchantAuth(recoverAgentHandler'), 'merchant auth wrapper');
  assert.ok(recoverSrc.includes('body?.txHash'), 'txHash is the recovery identifier');
  assert.ok(recoverSrc.includes('TX_HASH_RE.test(txHash)'), 'txHash validated 0x-64-hex');
  for (const denied of ['body?.walletSetId', 'body.walletSetId', 'body?.ownerAddress', 'body.ownerAddress',
    'body?.tokenId', 'body.tokenId', 'body?.merchantId', 'body.merchantId', 'body?.validatorSca', 'body.validatorSca']) {
    assert.ok(!recoverSrc.includes(denied), `must never read ${denied}`);
  }
});

test('recover route: merchant deploy intents are the authoritative ownership source', () => {
  assert.ok(recoverSrc.includes('agentDeployIntent.findMany'), 'loads server-side intents');
  assert.ok(recoverSrc.includes('where: { merchantId: merchant.id }'), 'intents scoped to authenticated merchant');
  assert.ok(recoverSrc.includes('intents.length === 0'), 'refuses merchants with no deploy intent');
  assert.ok(recoverSrc.includes('status: 403'), 'no-intent refusal is a 403');
  assert.ok(recoverSrc.includes('matchDeployIntentToMint(intents, mint.to, txHash)'),
    'mints matched to intent ownerSca via the pure matcher');
  assert.ok(!recoverSrc.includes('getCallerControlledAddresses(request') &&
    !recoverSrc.includes('getCallerControlledAddresses} from'),
    'recovery must NOT depend on getCallerControlledAddresses');
});

test('recover route: Circle wallet-set membership is checked on the SERVER-STORED walletSetId', () => {
  assert.ok(recoverSrc.includes('circleClient.listWallets'), 'read-only Circle membership call');
  assert.ok(recoverSrc.includes('listWallets({ walletSetId: intent.walletSetId })'),
    'membership uses the server-stored intent walletSetId, never a client value');
  assert.ok(recoverSrc.includes("not a wallet in this deployment's recorded Circle wallet set"),
    'rejects holder outside the recorded wallet set');
  assert.ok(recoverSrc.includes('status: 403'), 'membership failure is a 403');
});

test('recover route: proofs + rejections + idempotency are wired', () => {
  assert.ok(recoverSrc.includes('extractIdentityMintFromLogs(receipt.logs'), 'identity from receipt logs');
  assert.ok(recoverSrc.includes('status: 422'), 'non-registration tx refused (no guess)');
  assert.ok(recoverSrc.includes('status: 404'), 'missing receipt refused');
  assert.ok(recoverSrc.includes('already belongs to a different merchant') && recoverSrc.includes('status: 409'),
    'cross-merchant conflict refused');
  assert.ok(recoverSrc.includes('agentRegistry.findUnique') && recoverSrc.includes('replayed: true'),
    'existing row replayed idempotently');
  assert.ok(recoverSrc.includes('P2002') && recoverSrc.includes('replayed: true'),
    'concurrent P2002 race replayed idempotently');
  assert.ok(!recoverSrc.includes('createWalletSet') && !recoverSrc.includes('createWallets'),
    'recovery never provisions Circle wallets');
  assert.ok(!recoverSrc.includes('createContractExecutionTransaction') && !recoverSrc.includes('abiFunctionSignature'),
    'recovery never submits a second registration');
  assert.ok(recoverSrc.includes('walletSetId: intent.walletSetId'), 'persists walletSetId on AgentRegistry');
  assert.ok(recoverSrc.includes('validatorSca: intent.validatorSca'), 'persists validatorSca on AgentRegistry');
  assert.ok(recoverSrc.includes('circleWalletId: intent.circleWalletId ?? null'), 're-links owner circleWalletId');
  assert.ok(recoverSrc.includes('ACTIVE_AGENT_PROVISIONED') && recoverSrc.includes('merchantId: merchant.id'),
    'persists real identity as ACTIVE under the authenticated merchant');
});

test('verifyCallerControlsAddress is not weakened (module still its own gate)', () => {
  assert.ok(controlsSrc.includes('export async function verifyCallerControlsAddress'),
    'ownership gate function still exists');
  assert.ok(controlsSrc.includes('export async function getCallerControlledAddresses'),
    'address-enumeration helper still exists');
  assert.ok(controlsSrc.includes('return null;'), 'gate still fails closed');
});

// ── Live AgentDeployIntent persistence proofs (Neon dev; created + deleted) ──
const { PrismaClient } = await import('@prisma/client');

function uniqueHex(prefix) {
  return `${prefix}${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`.slice(0, 42).padEnd(42, '0');
}

test('live: AgentDeployIntent row persists the server-derived binding', async () => {
  const prisma = new PrismaClient();
  const walletSetId = `test-ws-${Date.now()}`;
  let id = null;
  try {
    const created = await prisma.agentDeployIntent.create({
      data: {
        merchantId: 'test-merchant-intent',
        walletSetId,
        ownerSca: uniqueHex('0xio'),
        validatorSca: uniqueHex('0xiv'),
        circleWalletId: 'test-circle-wallet',
        idempotencyKey: 'test-deploy-key',
        status: 'PROVISIONING',
      },
    });
    id = created.id;
    assert.equal(created.walletSetId, walletSetId);
    assert.equal(created.merchantId, 'test-merchant-intent');
    assert.equal(created.status, 'PROVISIONING');
    const reread = await prisma.agentDeployIntent.findUnique({ where: { id } });
    assert.equal(reread.walletSetId, walletSetId);
    assert.equal(reread.ownerSca, created.ownerSca);
    assert.equal(reread.validatorSca, created.validatorSca);
  } finally {
    if (id !== null) await prisma.agentDeployIntent.delete({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  }
});

test('live: merchant + idempotencyKey is unique (DB-level replay backstop)', async () => {
  const prisma = new PrismaClient();
  const walletSetId = `test-ws-${Date.now()}`;
  const walletSetId2 = `test-ws2-${Date.now()}`;
  let id = null;
  try {
    id = (await prisma.agentDeployIntent.create({
      data: {
        merchantId: 'test-merchant-intent',
        walletSetId,
        ownerSca: uniqueHex('0xdu'),
        validatorSca: uniqueHex('0xdv'),
        idempotencyKey: 'test-deploy-key-dupe',
        status: 'PROVISIONING',
      },
    })).id;
    await assert.rejects(
      prisma.agentDeployIntent.create({
        data: {
          merchantId: 'test-merchant-intent',
          walletSetId: walletSetId2,
          ownerSca: uniqueHex('0xdu2'),
          validatorSca: uniqueHex('0xdv2'),
          idempotencyKey: 'test-deploy-key-dupe',
          status: 'PROVISIONING',
        },
      }),
      (e) => e?.code === 'P2002',
      'duplicate (merchantId, idempotencyKey) must be rejected by the unique constraint'
    );
  } finally {
    if (id !== null) await prisma.agentDeployIntent.delete({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
