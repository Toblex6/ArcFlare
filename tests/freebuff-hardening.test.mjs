// tests/freebuff-hardening.test.mjs — Freebuff product-hardening regression tests.
//
// Covers ONLY the gaps closed in feat(cleanup): complete remaining Freebuff
// product hardening (canonical agent identity for the last [id] routes,
// invalid-jobId 400 parity across job routes, legacy jobs-route canonical
// ERC-8183 usage). Static source checks, no network, no DB:
//   node --test tests/freebuff-hardening.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. Canonical agent identity: every [id] route resolves via the ──────────
// canonical resolver (registry id, ERC-8004 tokenId, or SCA address; ambiguity
// refused) while preserving the legacy 400/404 contract.

const CANONICAL_ID_ROUTES = [
  'src/app/api/agents/[id]/wallet/route.ts',
  'src/app/api/agents/[id]/ledger/route.ts',
  'src/app/api/agents/[id]/track-record/route.ts',
];

for (const rel of CANONICAL_ID_ROUTES) {
  test(`${rel} resolves identity via resolveAgentRouteRef`, () => {
    const src = read(rel);
    assert.ok(
      src.includes('resolveAgentRouteRef'),
      `${rel} must use resolveAgentRouteRef (canonical agent identity)`
    );
    assert.ok(
      !src.includes('Number(id)') && !src.includes('Number( id )'),
      `${rel} must not resolve identity via Number(id)`
    );
  });

  test(`${rel} preserves legacy 400/404 semantics`, () => {
    const src = read(rel);
    assert.ok(src.includes('ambiguous agent reference'), `${rel} must answer 400 on ambiguous references`);
    assert.ok(src.includes('invalid agent id'), `${rel} must answer 400 on malformed references`);
    assert.ok(src.includes('404'), `${rel} must answer 404 on unknown references`);
  });
}

test('wallet route still gates on caller control + step-up before provisioning', () => {
  const src = read('src/app/api/agents/[id]/wallet/route.ts');
  const controlIdx = src.indexOf('verifyCallerControlsAddress');
  const createIdx = src.indexOf('await getOrCreateAgentWallet');
  assert.ok(controlIdx !== -1 && createIdx !== -1 && controlIdx < createIdx,
    'authorization must run before any wallet provisioning');
  assert.ok(src.includes('requireConsumerStepUpForActor'),
    'consumer step-up gate must be preserved');
});

// ── 2. Invalid-jobId parity: malformed jobIds are caller errors (400), ──────
// never 500s — the same contract as the canonical accept/fund routes.

const JOB_ID_GUARDED_ROUTES = [
  'src/app/api/jobs/[jobId]/applicants/route.ts',
  'src/app/api/jobs/[jobId]/validation/request/route.ts',
  'src/app/api/jobs/[jobId]/validation/respond/route.ts',
  'src/app/api/jobs/[jobId]/validation/route.ts',
  'src/app/api/jobs/[jobId]/route.ts',
  'src/app/api/jobs/route.ts', // GET ?jobId= handler + requireJob preflight
  'src/app/api/jobs/fund/route.ts',
  'src/app/api/jobs/submit/route.ts',
  'src/app/api/jobs/complete/route.ts',
  'src/app/api/jobs/set-budget/route.ts',
];

for (const rel of JOB_ID_GUARDED_ROUTES) {
  test(`${rel} answers 400 on malformed jobIds`, () => {
    const src = read(rel);
    assert.ok(src.includes('BigInt(jobId'), `${rel} must parse jobId via BigInt`);
    assert.ok(src.includes('invalid job id'), `${rel} must have an invalid-job-id 400 path`);
    assert.ok(src.includes('status: 400'), `${rel} must return status 400`);
  });
}

test('legacy jobs route requireJob rejects malformed jobIds with 400, not 502', () => {
  const src = read('src/app/api/jobs/route.ts');
  const guardIdx = src.indexOf('invalid job id');
  assert.ok(guardIdx !== -1, 'requireJob must have an invalid-job-id path');
  assert.ok(src.includes('PreflightError(400,'), 'malformed jobIds must surface as PreflightError 400');
});

// ── 3. Legacy jobs route uses the canonical ERC-8183 config (no drift). ─────

test('legacy jobs route imports ABI + addresses from the canonical config', () => {
  const src = read('src/app/api/jobs/route.ts');
  assert.ok(src.includes('agenticCommerceAbi'), 'must use the canonical agenticCommerceAbi');
  assert.ok(
    /from\s+['"]@\/lib\/contracts\/erc8183['"]/.test(src),
    'must import from @/lib/contracts/erc8183'
  );
  assert.ok(!src.includes('const AGENTIC_ABI'), 'local AGENTIC_ABI duplicate must stay removed');
  assert.ok(!/const\s+(USDC_ARC|USDC_CONTRACT)\s*=/.test(src), 'must not declare local address constants');
});
