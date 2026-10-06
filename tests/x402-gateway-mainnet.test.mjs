// tests/x402-gateway-mainnet.test.mjs — x402 Gateway Mainnet safety (Option B).
//
// A MAINNET REQUEST MUST NEVER EXECUTE AGAINST ARC TESTNET. The Gateway
// feature is not Mainnet-ready (no verified Arc Mainnet Gateway chain value
// exists in this repo), so every GatewayClient path fails closed on mainnet
// with "x402 Gateway is not available on Arc Mainnet yet" (503), and the
// legacy BUYER_PRIVATE_KEY fallback is unreachable on mainnet. Testnet
// behavior is unchanged.
//
// Static + unit, no chain/DB/network I/O. Run: npx tsx --test tests/x402-gateway-mainnet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
// Production sources with `//` line comments stripped (historical SDK-pattern
// comments mentioning testnet literals are documentation, not config).
const readCode = (f) =>
  read(f)
    .split('\n')
    .map((l) => l.split('//')[0])
    .join('\n');

const net = await import('../src/lib/config/network.ts');
const gw = await import('../src/lib/x402-gateway.ts');

// Full mainnet environment (self-consistent placeholders — same shape as
// tests/network-config.test.mjs MAINNET_ENV, every value differs from testnet).
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

// The 5 production GatewayClient construction sites (entire x402/Gateway surface in src/).
const GATEWAY_FILES = [
  'src/app/api/x402/pay/route.ts',
  'src/app/api/x402/seller/balance/withdraw/route.ts',
  'src/app/api/x402/eoa-wallet/me/route.ts',
  'src/app/api/x402/eoa-wallet/deposit/route.ts',
  'src/lib/payroll/payrollExecution.ts',
];

// ── 1. Testnet behavior unchanged ──────────────────────────────────────────
test('testnet: Gateway available, chain resolves to arcTestnet', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.equal(gw.isGatewayAvailable(), true);
    assert.equal(gw.requireGatewayChain(), 'arcTestnet');
  });
});

// ── 2. Mainnet fails closed ────────────────────────────────────────────────
test('mainnet: Gateway unavailable, chain resolution throws (never arcTestnet)', async () => {
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(gw.isGatewayAvailable(), false);
    assert.throws(
      () => gw.requireGatewayChain(),
      (e) => e instanceof gw.GatewayMainnetUnavailableError &&
        e.code === 'gateway_mainnet_unavailable' &&
        e.message.includes('not available on Arc Mainnet yet') &&
        !e.message.includes('arcTestnet'),
      'mainnet chain resolution must throw the typed error, never return arcTestnet'
    );
    const body = gw.gatewayUnavailableBody();
    assert.equal(body.success, false);
    assert.equal(body.code, 'gateway_mainnet_unavailable');
    assert.ok(body.error.includes('not available on Arc Mainnet yet'));
  });
});

// ── 3. Mainnet gate does not depend on full mainnet config ─────────────────
// isGatewayAvailable reads only the network selector — even a bare
// ARC_NETWORK=mainnet (missing ARC_MAINNET_* values) fails closed on the
// Gateway path with the Gateway error, not a config crash.
test('mainnet gate holds without any ARC_MAINNET_* values configured', async () => {
  await withEnv({ ARC_NETWORK: 'mainnet' }, async () => {
    assert.equal(gw.isGatewayAvailable(), false);
    assert.throws(() => gw.requireGatewayChain(), (e) => e instanceof gw.GatewayMainnetUnavailableError);
  });
});

// ── 4. Every production GatewayClient site gates + never hardcodes ─────────
test('all GatewayClient sites fail closed on mainnet and never hardcode arcTestnet', async () => {
  for (const f of GATEWAY_FILES) {
    const src = readCode(f);
    assert.match(src, /isGatewayAvailable\(\)/, `${f} must gate on isGatewayAvailable()`);
    assert.match(src, /requireGatewayChain\(\)/, `${f} must resolve the chain via requireGatewayChain()`);
    assert.ok(
      !src.includes('chain: "arcTestnet"') && !src.includes("chain: 'arcTestnet'"),
      `${f} must not hardcode chain arcTestnet (a mainnet request must never execute against testnet)`
    );
  }
  // Route handlers answer 503 with the shared body; the lib path throws the typed error.
  for (const f of GATEWAY_FILES.filter((x) => x.startsWith('src/app/'))) {
    const src = readCode(f);
    assert.match(src, /gatewayUnavailableBody\(\)/, `${f} must return the shared unavailable body`);
    assert.match(src, /status:\s*503/, `${f} must answer 503 on mainnet`);
  }
  const sweep = readCode('src/lib/payroll/payrollExecution.ts');
  assert.match(sweep, /throw new GatewayMainnetUnavailableError\(\)/, 'payroll sweep must throw the typed error on mainnet');
});

// ── 5. No BUYER_PRIVATE_KEY fallback reachable on mainnet ───────────────────
test('BUYER_PRIVATE_KEY fallback is unreachable on mainnet in x402/pay', async () => {
  const src = readCode('src/app/api/x402/pay/route.ts');
  const gateIdx = src.indexOf('isGatewayAvailable()');
  const fallbackIdx = src.indexOf('BUYER_PRIVATE_KEY');
  assert.ok(gateIdx !== -1 && fallbackIdx !== -1, 'both the gate and the legacy fallback must exist in the file');
  assert.ok(
    gateIdx < fallbackIdx,
    'the mainnet 503 guard must run BEFORE the legacy BUYER_PRIVATE_KEY fallback is touched'
  );
});

// ── 6. Option B justification: no verified mainnet Gateway chain in repo ───
// The Circle SDK supports `chain: "arc"` but nothing in this repo configures
// it (no ARC_MAINNET_GATEWAY_CHAIN env, no literal) — inventing mainnet
// Gateway behavior would be speculative, so fail-closed is correct.
test('no verified mainnet Gateway chain value exists in src (Option B justified)', async () => {
  for (const f of [...GATEWAY_FILES, 'src/lib/config/network.ts', 'src/lib/x402.ts']) {
    const src = readCode(f);
    assert.ok(
      !src.includes('chain: "arc"') && !src.includes("chain: 'arc'"),
      `${f} must not invent a mainnet Gateway chain value`
    );
  }
  const envExample = read('.env.example');
  assert.ok(!envExample.includes('ARC_MAINNET_GATEWAY_CHAIN'), '.env.example must not promise an unconfigured mainnet Gateway chain');
});

// ── 7. Frozen withGateway() untouched ───────────────────────────────────────
test('frozen x402.ts facilitator path untouched (config-driven, already fail-closed)', async () => {
  const x402 = read('src/lib/x402.ts');
  assert.match(x402, /getNetworkConfig\(\)\.gatewayUrl/);
  assert.ok(!x402.includes('requireGatewayChain'), 'x402.ts must not be touched by the GatewayClient gate');
  assert.ok(!x402.includes('isGatewayAvailable'), 'x402.ts must not be touched by the GatewayClient gate');
});
