// tests/network-centralization.test.mjs — centralization-gap regression coverage.
//
// Proves, for the network-config cutover (dca98e6 + follow-up hardening):
//   A. ARC_NETWORK=testnet → existing testnet behavior is fully unchanged.
//   B. ARC_NETWORK=mainnet → production consumers resolve the configured
//      mainnet values (never silently inherit testnet).
//   C. No production money path can silently import the static ERC-8183
//      testnet pin (src/lib/contracts/erc8183.ts) — the network config is the
//      single authority, and the legacy AGENTIC_COMMERCE_CONTRACT / ARC_USDC_ADDRESS
//      env overrides are not honored anywhere in production code.
//
// All checks are static/unit: no live chain, no DB, no network I/O. The network
// config module is imported directly and exercised through its env seams.
// Run: npx tsx --test tests/network-centralization.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SRC_ROOT = path.join(ROOT, 'src');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const net = await import('../src/lib/config/network.ts');

// Self-consistent mainnet environment (every placeholder differs from the
// testnet set — copied verbatim from tests/network-config.test.mjs).
const A1 = '0x' + '1'.repeat(40); // CCTP MessageTransmitter
const A2 = '0x' + '2'.repeat(40); // USDC
const A3 = '0x' + '3'.repeat(40); // EURC
const A4 = '0x' + '4'.repeat(40); // ERC-8183 AgenticCommerce
const A5 = '0x' + '5'.repeat(40); // x402 verifier
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

// The ERC-8183 testnet pin that MUST live in exactly one place: erc8183.ts.
const ERC8183_PIN = '0x0747EEf0706327138c69792bF28Cd525089e4583';
// Source files whose erc8183 import must not reference the static pin.
const MONEY_PATHS = [
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

// ── A. Testnet behavior is fully unchanged ──────────────────────────────────
test('A: ARC_NETWORK=testnet reproduces the exact live testnet values', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.name, 'testnet');
    assert.equal(cfg.chainId, 5042002);
    assert.equal(cfg.erc8183Address, ERC8183_PIN);
    assert.equal(cfg.usdcAddress, '0x3600000000000000000000000000000000000000');
    assert.equal(cfg.eurcAddress, '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a');
    assert.equal(cfg.cctpDomain, 26);
    assert.equal(cfg.cctpMessageTransmitter, '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275');
    assert.equal(cfg.primaryRpc, 'https://rpc.testnet.arc.network');
    assert.equal(cfg.circleBlockchain, 'ARC-TESTNET');
  });
});

// ── B. Mainnet consumers resolve configured values only ─────────────────────
test('B: ARC_NETWORK=mainnet resolves the configured mainnet values', async () => {
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.name, 'mainnet');
    assert.equal(cfg.chainId, 5042001);
    assert.equal(cfg.erc8183Address, A4); // NOT the testnet pin
    assert.equal(cfg.usdcAddress, A2);
    assert.equal(cfg.eurcAddress, A3);
    assert.equal(cfg.cctpDomain, 27);
    assert.equal(cfg.cctpMessageTransmitter, A1);
    assert.notEqual(cfg.erc8183Address, ERC8183_PIN);
  });
});

// ── C. No production money path can import the static ERC-8183 pin ──────────
test('C: no money path imports AGENTIC_COMMERCE_CONTRACT from erc8183.ts (network config is the authority)', () => {
  for (const p of MONEY_PATHS) {
    const src = read(p);
    assert.match(
      src,
      /getNetworkConfig\(\)\.erc8183Address/,
      `${p} must resolve the ERC-8183 address from getNetworkConfig()`
    );
    const erc8183Imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/contracts\/erc8183['"]/g)];
    assert.ok(
      erc8183Imports.every((m) => !/AGENTIC_COMMERCE_CONTRACT/.test(m[1])),
      `${p} must not import the static AGENTIC_COMMERCE_CONTRACT`
    );
    // No legacy env override of the ERC-8183 address either.
    assert.ok(
      !/process\.env\.AGENTIC_COMMERCE_CONTRACT/.test(src),
      `${p} must not honor the AGENTIC_COMMERCE_CONTRACT env override`
    );
  }
});

test('C: the ERC-8183 address literal lives in ONLY erc8183.ts', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) offenders.push(full);
    }
  };
  walk(SRC_ROOT);
  const pin = ERC8183_PIN.toLowerCase();
  const holders = offenders
    .filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(pin))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.deepEqual(holders, ['src/lib/contracts/erc8183.ts']);
});

test('C: stale USDC env overrides are gone from balance/verification', () => {
  for (const p of ['src/lib/wallet/usdcBalance.ts', 'src/lib/arcEngine.ts']) {
    const src = read(p);
    assert.ok(
      !src.includes('ARC_USDC_ADDRESS'),
      `${p} must not reference the legacy ARC_USDC_ADDRESS override`
    );
    assert.match(src, /getNetworkConfig\(\)\.usdcAddress/, `${p} must use the network-config USDC address`);
  }
});

test('C: CCTP destination config derives from network.ts (no inlined testnet CCTP values)', () => {
  const cctpV2 = read('src/lib/cctp-v2.ts');
  assert.match(cctpV2, /getNetworkConfig\(\)/, 'cctp-v2 must import the network config');
  assert.match(cctpV2, /destinationDomain:\s*net\.cctpDomain/, 'cctp-v2 destination domain must come from config');
  assert.match(cctpV2, /messageTransmitter:\s*net\.cctpMessageTransmitter/, 'cctp-v2 MessageTransmitter must come from config');
  assert.match(cctpV2, /irisApiUrl:\s*net\.irisApiUrl/, 'cctp-v2 Iris URL must come from config');
  assert.match(cctpV2, /testnet:\s*net\.name !== 'mainnet'/, 'cctp-v2 testnet flag must be derived from config');
});