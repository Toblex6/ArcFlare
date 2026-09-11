// tests/erc8183-config-drift.test.mjs — P0 #3: ERC-8183 address configuration drift regression tests.
//
// The canonical ERC-8183 (AgenticCommerce) address and ABI live in
// src/lib/contracts/erc8183.ts. Every consumer must import from there;
// inline literals drift silently (audit finding P0 #3).
// Run read-only (static source checks, no network, no DB):
//   node --test tests/erc8183-config-drift.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SRC_ROOT = path.join(ROOT, 'src');
const ERC8183_ADDRESS = '0x0747EEf0706327138c69792bF28Cd525089e4583';
const CANONICAL_REL = 'src/lib/contracts/erc8183.ts';

// Known, deliberately allow-listed duplicates (documented exceptions):
// - src/lib/contracts/erc8183.ts: the canonical definition itself.
const ALLOWED = new Set([CANONICAL_REL]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const read = (file) => readFileSync(file, 'utf8');
const ADDRESS_RE = /0x0747eef0706327138c69792bf28cd525089e4583/i;

test('canonical config exports the expected ERC-8183 address', () => {
  const canonical = read(path.join(ROOT, CANONICAL_REL));
  assert.ok(
    canonical.includes(`export const AGENTIC_COMMERCE_CONTRACT = '${ERC8183_ADDRESS}'`),
    'canonical export line must remain the single source of truth for the ERC-8183 address'
  );
});

test('no ERC-8183 address literals outside the canonical config (allow-listed exceptions only)', () => {
  const offenders = [];
  for (const file of walk(SRC_ROOT)) {
    const relative = rel(file);
    if (ALLOWED.has(relative)) continue;
    // NOTE: new RegExp(ADDRESS_RE, 'g') would silently DROP the /i flag
    // (explicit flags replace, not merge) and make this scan case-sensitive
    // — missing checksummed literals. Keep both flags via .source.
    const matches = read(file).match(new RegExp(ADDRESS_RE.source, 'gi'));
    if (matches) offenders.push(`${relative} (${matches.length}x)`);
  }
  assert.deepEqual(
    offenders,
    [],
    `ERC-8183 address must be imported from ${CANONICAL_REL}, not inlined: ${offenders.join(', ')}`
  );
});

test('production money paths resolve the ERC-8183 address from network config (never the static pin)', () => {
  const consumers = [
    'src/app/api/jobs/route.ts',
    'src/app/api/jobs/create/route.ts',
    'src/app/api/jobs/fund/route.ts',
    'src/app/api/jobs/complete/route.ts',
    'src/app/api/jobs/set-budget/route.ts',
    'src/app/api/jobs/submit/route.ts',
    'src/app/api/jobs/[jobId]/accept/route.ts',
    'src/app/api/jobs/[jobId]/fund/route.ts',
    'src/app/api/jobs/[jobId]/route.ts',
    'src/app/api/agents/[id]/hire/route.ts',
    'src/app/api/agents/[id]/treasury/hire/route.ts',
    'src/app/api/procurement/[id]/hire/route.ts',
    'src/app/api/agents/[id]/card/route.ts',
    'src/app/api/nano/pay/[endpoint]/route.ts',
    'src/app/jobs/page.tsx',
  ];
  for (const c of consumers) {
    const src = read(path.join(ROOT, c));
    // Resolve the address from the authoritative network config.
    assert.match(
      src,
      /getNetworkConfig\(\)\.erc8183Address/,
      `${c} must resolve the ERC-8183 address from the network config`
    );
    // Must NOT import the static testnet pin from erc8183.ts.
    const erc8183From = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/contracts\/erc8183['"]/g)];
    assert.ok(
      erc8183From.every((m) => !/AGENTIC_COMMERCE_CONTRACT/.test(m[1])),
      `${c} must not import AGENTIC_COMMERCE_CONTRACT (static pin) from erc8183.ts`
    );
  }
});

test('jobs route no longer carries a local duplicate ABI or address constants', () => {
  const src = read(path.join(ROOT, 'src/app/api/jobs/route.ts'));
  assert.ok(!src.includes('const AGENTIC_ABI'), 'local AGENTIC_ABI duplicate must stay removed');
  assert.ok(src.includes('agenticCommerceAbi'), 'jobs route must use the canonical agenticCommerceAbi');
  assert.ok(
    !/const\s+(AGENTIC_COMMERCE_CONTRACT|USDC_ARC|USDC_CONTRACT)\s*=/.test(src),
    'jobs route must not declare local contract-address constants'
  );
});

test('agent brain route no longer carries local contract-address constants', () => {
  const src = read(path.join(ROOT, 'src/app/api/agent/brain/route.ts'));
  assert.ok(
    !/const\s+(AGENTIC_COMMERCE|USDC_ARC)\s*=/.test(src),
    'brain route must not re-declare ERC-8183/USDC addresses locally'
  );
});
