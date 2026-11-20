// x402 Gateway mainnet config gate. Static/unit only; no network/DB/funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
// Inspect executable code, not historical SDK examples in line comments.
const readCode = (f) => read(f).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
const net = await import('../src/lib/config/network.ts');
const gw = await import('../src/lib/x402-gateway.ts');
const { x402UnavailableResponse } = await import('../src/lib/x402/availability.ts');
const MAINNET = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io',
  ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.io',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api.circle.com',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.com/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  ARC_MAINNET_EURC_ADDRESS: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
  SELLER_ADDRESS: '0x' + '2'.repeat(40),
};
async function withEnv(env, fn) {
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key === 'X402_MAINNET_ENABLED' || key.startsWith('ARC_MAINNET_') || key === 'ARC_NETWORK' || key === 'SELLER_ADDRESS') delete process.env[key];
    }
    Object.assign(process.env, env);
    net.__resetNetworkConfigCacheForTests();
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    net.__resetNetworkConfigCacheForTests();
  }
}

test('testnet remains arcTestnet', async () => withEnv({ ARC_NETWORK: 'testnet' }, () => {
  assert.equal(gw.isGatewayAvailable(), true);
  assert.equal(gw.requireGatewayChain(), 'arcTestnet');
}));

for (const flag of [undefined, '', 'false', '0']) test(`mainnet flag ${JSON.stringify(flag)} fails closed`, async () => {
  const env = { ...MAINNET };
  if (flag !== undefined) env.X402_MAINNET_ENABLED = flag;
  await withEnv(env, async () => {
    assert.equal(gw.isGatewayAvailable(), false);
    assert.throws(() => gw.requireGatewayChain(), gw.GatewayMainnetUnavailableError);
    assert.equal(gw.gatewayUnavailableBody().code, 'gateway_mainnet_unavailable');
    const response = x402UnavailableResponse();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'x402_disabled');
  });
});

for (const flag of ['true', '1']) test(`mainnet valid flag ${flag} resolves arc`, async () => withEnv({ ...MAINNET, X402_MAINNET_ENABLED: flag }, () => {
  assert.equal(gw.isGatewayAvailable(), true);
  assert.equal(gw.requireGatewayChain(), 'arc');
  assert.equal(x402UnavailableResponse(), null);
}));

for (const [label, patch] of [
  ['wrong chain', { ARC_MAINNET_CHAIN_ID: '5043' }],
  ['wrong facilitator', { ARC_MAINNET_GATEWAY_URL: 'https://example.com' }],
  ['wrong USDC', { ARC_MAINNET_USDC_ADDRESS: '0x' + '3'.repeat(40) }],
  ['wrong verifier', { ARC_MAINNET_X402_VERIFIER: '0x' + '4'.repeat(40) }],
  ['bad payTo', { SELLER_ADDRESS: 'bad' }],
  ['zero payTo', { SELLER_ADDRESS: '0x' + '0'.repeat(40) }],
]) test(`mainnet ${label} fails closed`, async () => withEnv({ ...MAINNET, ...patch, X402_MAINNET_ENABLED: 'true' }, async () => {
  assert.equal(gw.isGatewayAvailable(), false);
  assert.throws(() => gw.requireGatewayChain(), gw.GatewayMainnetUnavailableError);
  const response = x402UnavailableResponse();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'x402_misconfigured');
}));

for (const flag of [false, true]) test(`incomplete mainnet configuration returns 503, enabled=${flag}`, async () => withEnv({
  ARC_NETWORK: 'mainnet', X402_MAINNET_ENABLED: String(flag),
}, async () => {
  assert.equal(gw.isGatewayAvailable(), false);
  assert.throws(() => gw.requireGatewayChain(), gw.GatewayMainnetUnavailableError);
  assert.equal(gw.gatewayUnavailableBody().success, false);
  const response = x402UnavailableResponse();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, flag ? 'x402_misconfigured' : 'x402_disabled');
}));

const files = [
  'src/app/api/x402/pay/route.ts',
  'src/app/api/x402/seller/balance/withdraw/route.ts',
  'src/app/api/x402/eoa-wallet/me/route.ts',
  'src/app/api/x402/eoa-wallet/deposit/route.ts',
  'src/lib/payroll/payrollExecution.ts',
];
test('all GatewayClient sites gate and resolve chain', () => {
  for (const file of files) {
    const source = readCode(file);
    assert.match(source, /isGatewayAvailable\(\)/, file);
    assert.match(source, /requireGatewayChain\(\)/, file);
    assert.doesNotMatch(source, /chain:\s*['"]arcTestnet['"]/, file);
    if (file.startsWith('src/app/')) {
      assert.match(source, /gatewayUnavailableBody\(\)/, file);
      assert.match(source, /status:\s*503/, file);
    }
  }
  assert.match(readCode('src/lib/payroll/payrollExecution.ts'), /throw new GatewayMainnetUnavailableError\(\)/);
});

test('pay requires an explicit merchant and caller-controlled wallet before Gateway construction', () => {
  const source = readCode('src/app/api/x402/pay/route.ts');
  assert.doesNotMatch(source, /BUYER_PRIVATE_KEY|BUYER_ADDRESS|legacyKey/);
  assert.match(source, /if \(!merchant\)[\s\S]*?status:\s*403/);
  assert.match(source, /verifyCallerControlsAddress\(req, wallet.address\)/);
  assert.match(source, /if \(!actor\)[\s\S]*?status:\s*403/);
  assert.ok(source.indexOf('if (!merchant)') < source.indexOf('getOrCreateBuyerWallet(merchant.id)'));
  assert.ok(source.indexOf('if (!actor)') < source.indexOf('new GatewayClient('));
});

test('frozen x402 facilitator remains untouched by client gate', () => {
  const source = read('src/lib/x402.ts');
  assert.match(source, /getNetworkConfig\(\)\.gatewayUrl/);
  assert.ok(!source.includes('requireGatewayChain'));
  assert.ok(!source.includes('isGatewayAvailable'));
});
