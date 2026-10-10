// tests/erc8004-network-config.test.mjs — ERC-8004 registry network-selection regression tests.
//
// Diagnosis: the agent deploy/recover/card routes resolved the ERC-8004
// registries via `process.env.X || <testnet pin>`, so selecting
// ARC_NETWORK=mainnet without the legacy env vars silently used the Arc
// Testnet registries on Mainnet. The authoritative network config
// (src/lib/config/network.ts) now owns all three ERC-8004 addresses with the
// official per-network pins from https://docs.arc.io/arc/references/contract-addresses.
//
// Scope: static/unit only — no live chain, no DB, no network I/O. The network
// config module is imported directly and exercised through its explicit env
// seams; the three routes are verified statically (heavy next/Prisma/Circle
// deps make live HTTP testing impractical — same convention as
// tests/deploy-identity.test.mjs).
// Run: npx tsx --test tests/erc8004-network-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const net = await import('../src/lib/config/network.ts');

// Official ERC-8004 pins (docs.arc.io/arc/references/contract-addresses).
const TESTNET = {
  identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  validation: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
};
const MAINNET = {
  identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  validation: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
};

// Self-consistent mainnet env (copied from tests/network-config.test.mjs —
// every placeholder differs from the testnet set; no ERC-8004 vars needed
// because the official mainnet pins are the defaults).
const A1 = '0x' + '1'.repeat(40);
const A2 = '0x' + '2'.repeat(40);
const A3 = '0x' + '3'.repeat(40);
const A4 = '0x' + '4'.repeat(40);
const A5 = '0x' + '5'.repeat(40);
const MAINNET_ENV = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042001',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC-MAINNET',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://arcscan.example/',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api-mainnet.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '27',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: A1,
  ARC_MAINNET_USDC_ADDRESS: A2,
  ARC_MAINNET_EURC_ADDRESS: A3,
  ARC_MAINNET_ERC8183_ADDRESS: A4,
  ARC_MAINNET_X402_VERIFIER: A5,
};

const withEnv = async (env, fn) => {
  const prev = { ...process.env };
  try {
    for (const k of Object.keys(env)) process.env[k] = env[k];
    net.__resetNetworkConfigCacheForTests();
    await fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, prev);
    net.__resetNetworkConfigCacheForTests();
  }
};

// ── 1. Testnet selects the official testnet registries ──────────────────────
test('testnet selects the official ERC-8004 testnet registries', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.name, 'testnet');
    assert.equal(cfg.identityRegistryAddress, TESTNET.identity);
    assert.equal(cfg.reputationRegistryAddress, TESTNET.reputation);
    assert.equal(cfg.validationRegistryAddress, TESTNET.validation);
  });
});

// ── 2. Mainnet selects the official mainnet registries ──────────────────────
test('mainnet selects the official ERC-8004 mainnet registries', async () => {
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.name, 'mainnet');
    assert.equal(cfg.identityRegistryAddress, MAINNET.identity);
    assert.equal(cfg.reputationRegistryAddress, MAINNET.reputation);
    assert.equal(cfg.validationRegistryAddress, MAINNET.validation);
  });
});

// ── 3. Mainnet can never silently fall back to testnet ──────────────────────
test('mainnet registries never equal the testnet pins', async () => {
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.notEqual(cfg.identityRegistryAddress, TESTNET.identity);
    assert.notEqual(cfg.reputationRegistryAddress, TESTNET.reputation);
    assert.notEqual(cfg.validationRegistryAddress, TESTNET.validation);
    assert.notEqual(cfg.identityRegistryAddress.toLowerCase(), TESTNET.identity.toLowerCase());
    assert.notEqual(cfg.reputationRegistryAddress.toLowerCase(), TESTNET.reputation.toLowerCase());
    assert.notEqual(cfg.validationRegistryAddress.toLowerCase(), TESTNET.validation.toLowerCase());
  });
});

test('explicit testnet registry on mainnet fails closed (never silently used)', async () => {
  const cases = [
    ['ARC_MAINNET_IDENTITY_REGISTRY', TESTNET.identity],
    ['ARC_MAINNET_REPUTATION_REGISTRY', TESTNET.reputation],
    ['ARC_MAINNET_VALIDATION_REGISTRY', TESTNET.validation],
  ];
  for (const [key, testnetPin] of cases) {
    await withEnv({ ...MAINNET_ENV, [key]: testnetPin }, async () => {
      assert.throws(
        () => net.getNetworkConfig(),
        (e) => e.message.includes('testnet') && e.message.includes('mainnet'),
        `${key}=testnet pin must fail closed`
      );
    });
  }
  // Malformed override fails closed too.
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_IDENTITY_REGISTRY: '0x1234' }, async () => {
    assert.throws(() => net.getNetworkConfig(), /ARC_MAINNET_IDENTITY_REGISTRY/);
  });
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_REPUTATION_REGISTRY: 'not-an-address' }, async () => {
    assert.throws(() => net.getNetworkConfig(), /ARC_MAINNET_REPUTATION_REGISTRY/);
  });
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_VALIDATION_REGISTRY: '0x1234' }, async () => {
    assert.throws(() => net.getNetworkConfig(), /ARC_MAINNET_VALIDATION_REGISTRY/);
  });
});

// ── 4. Every registry consumer uses the central config (no own fallback) ───
// Covers the original deploy/recover/card fix plus the follow-up sweep:
// reputation readers/writers, track-record fallback, job-validation policy +
// all validation request/respond/status routes and the agent brain.
test('all ERC-8004 consumers resolve from getNetworkConfig (no testnet fallback)', () => {
  const IDENTITY_CONSUMERS = [
    'src/app/api/agent/deploy/route.ts',
    'src/app/api/agent/deploy/recover/route.ts',
  ];
  const REPUTATION_CONSUMERS = [
    'src/lib/trust/reputationReader.ts',
    'src/lib/trust/autoReputation.ts',
    'src/lib/trust/trackRecord.ts',
    'src/app/api/agent/reputation/route.ts',
    'src/app/api/agent/brain/route.ts',
  ];
  const VALIDATION_CONSUMERS = [
    'src/lib/jobs/jobValidationPolicy.ts',
    'src/app/api/agent/validation/route.ts',
    'src/app/api/jobs/[jobId]/validation/route.ts',
    'src/app/api/jobs/[jobId]/validation/request/route.ts',
    'src/app/api/jobs/[jobId]/validation/respond/route.ts',
    'src/app/api/agents/[id]/card/route.ts',
  ];
  const check = (file, field) => {
    const src = read(file);
    assert.ok(
      !src.includes('process.env.IDENTITY_REGISTRY_ADDRESS') &&
        !src.includes('process.env.REPUTATION_REGISTRY_ADDRESS') &&
        !src.includes('process.env.VALIDATION_REGISTRY_ADDRESS') &&
        !src.includes('process.env.NEXT_PUBLIC_VALIDATION_REGISTRY'),
      `${file} must not read legacy ERC-8004 env overrides`
    );
    // No hardcoded testnet registry literal left in the consumer (case-insensitive).
    for (const pin of Object.values(TESTNET)) {
      assert.ok(
        !src.toLowerCase().includes(pin.toLowerCase()),
        `${file} must not inline the testnet pin ${pin}`
      );
    }
    assert.match(
      src,
      new RegExp(`(?:getNetworkConfig\\(\\)\\.${field}|\\bnet\\.${field})`),
      `${file} must resolve the registry via getNetworkConfig().${field} (directly or via a getNetworkConfig() alias)`
    );
    assert.ok(src.includes('getNetworkConfig()'), `${file} must call getNetworkConfig()`);
  };
  for (const f of IDENTITY_CONSUMERS) check(f, 'identityRegistryAddress');
  for (const f of REPUTATION_CONSUMERS) check(f, 'reputationRegistryAddress');
  for (const f of VALIDATION_CONSUMERS) check(f, 'validationRegistryAddress');
});

// ── 4b. Pin single-authority: full registry literals live ONLY in network.ts ─
test('ERC-8004 registry literals live ONLY in src/lib/config/network.ts', () => {
  const SRC_ROOT = path.join(ROOT, 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  walk(SRC_ROOT);
  const pins = [...Object.values(TESTNET), ...Object.values(MAINNET)].map((p) => p.toLowerCase());
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === 'src/lib/config/network.ts') continue;
    const lower = readFileSync(f, 'utf8').toLowerCase();
    for (const pin of pins) {
      if (lower.includes(pin)) offenders.push(`${rel} contains ${pin}`);
    }
  }
  assert.deepEqual(offenders, [], `registry pins must live only in network.ts: ${offenders.join(', ')}`);
});

// ── 5. Misleading re-deploy hint is gone; recovery path is surfaced ─────────
test('deploy PENDING hint directs to recovery with the existing txHash (never re-deploy)', () => {
  const deploy = read('src/app/api/agent/deploy/route.ts');
  const guardBlock = deploy.slice(deploy.indexOf('if (!tokenId)'), deploy.indexOf('agentRegistry.create'));
  assert.ok(guardBlock.includes('POST /api/agent/deploy/recover'), 'PENDING response must point at the recover endpoint');
  assert.ok(guardBlock.includes('txHash'), 'PENDING response must carry the existing txHash');
  assert.ok(!guardBlock.includes('Re-run POST /api/agent/deploy'), 'misleading re-deploy instruction must be gone');
});
