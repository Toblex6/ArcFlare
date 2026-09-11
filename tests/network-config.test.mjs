// tests/network-config.test.mjs — Phase 1 network-configuration regression tests.
//
// Scope: the authoritative Arc network layer (src/lib/config/network.ts) and
// its consumption across production modules. All checks are static/unit:
// no live blockchain calls, no DB, no network I/O. The module under test is
// imported directly (no viem/runtime deps at module scope) and exercised
// through its explicit env-parameter seams.
// Run: npx tsx --test tests/network-config.test.mjs
// (plain `node --test` cannot resolve the repo's extensionless relative
// imports — src code targets the webpack/bundler resolution convention —
// so the TS-capable runner used by scripts/*.ts is used here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const net = await import('../src/lib/config/network.ts');

// Full mainnet environment (self-consistent placeholder values -- NOT
// copied from testnet; every value below differs from the testnet set).
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

// Production sources with `//` line comments stripped (comment mentions of
// testnet literals are legitimate historical documentation, not config).
const readCode = (f) =>
  read(f)
    .split('\n')
    .map((l) => l.split('//')[0])
    .join('\n');
// ── 1. Testnet config resolves to the exact existing known values ────────────
test('testnet config reproduces the live Arc Testnet values', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.name, 'testnet');
    assert.equal(cfg.chainId, 5042002);
    assert.equal(cfg.eip155, 'eip155:5042002');
    assert.equal(cfg.circleBlockchain, 'ARC-TESTNET');
    assert.equal(cfg.primaryRpc, 'https://rpc.testnet.arc.network');
    assert.deepEqual(cfg.fallbackRpcs, [
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io',
      'https://rpc.testnet.arc.io',
      'https://rpc.blockdaemon.testnet.arc.io',
    ]);
    assert.equal(cfg.explorerBaseUrl, 'https://testnet.arcscan.app');
    assert.equal(cfg.gatewayUrl, 'https://gateway-api-testnet.circle.com');
    assert.equal(cfg.irisApiUrl, 'https://iris-api-sandbox.circle.com/v2');
    assert.equal(cfg.cctpDomain, 26);
    assert.equal(cfg.cctpMessageTransmitter, '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275');
    assert.equal(cfg.x402Network, 'eip155:5042002');
    assert.equal(cfg.x402VerifierContract, '0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
    assert.equal(cfg.usdcAddress, '0x3600000000000000000000000000000000000000');
    assert.equal(cfg.eurcAddress, '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a');
    assert.equal(cfg.erc8183Address, '0x0747EEf0706327138c69792bF28Cd525089e4583');
    assert.equal(cfg.walletConnectChainId, 'eip155:5042002');
  });
});

// ── 2. Mainnet never silently inherits testnet values ────────────────────────
test('mainnet selection never inherits testnet values', async () => {
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.name, 'mainnet');
    assert.equal(cfg.chainId, 5042001);
    assert.equal(cfg.circleBlockchain, 'ARC-MAINNET');
    const TESTNET = {
      primaryRpc: 'https://rpc.testnet.arc.network',
      explorerBaseUrl: 'https://testnet.arcscan.app',
      gatewayUrl: 'https://gateway-api-testnet.circle.com',
      irisApiUrl: 'https://iris-api-sandbox.circle.com/v2',
      cctpMessageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      usdcAddress: '0x3600000000000000000000000000000000000000',
      eurcAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      erc8183Address: '0x0747EEf0706327138c69792bF28Cd525089e4583',
      x402VerifierContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      x402Network: 'eip155:5042002',
      eip155: 'eip155:5042002',
      walletConnectChainId: 'eip155:5042002',
    };
    for (const [field, tv] of Object.entries(TESTNET)) {
      assert.notEqual(cfg[field], tv, `mainnet ${field} must not inherit the testnet value`);
    }
    assert.equal(cfg.cctpDomain, 27);
    // Derived identifiers default from the configured mainnet chain ID.
    assert.equal(cfg.eip155, 'eip155:5042001');
    assert.equal(cfg.x402Network, 'eip155:5042001');
    assert.equal(cfg.walletConnectChainId, 'eip155:5042001');
    // Trailing slashes are normalized on URL inputs.
    assert.equal(cfg.explorerBaseUrl, 'https://arcscan.example');
  });
});

// ── 3. Missing required mainnet configuration fails closed ───────────────────
test('missing required mainnet configuration fails closed (never testnet fallback)', async () => {
  for (const required of net.MAINNET_REQUIRED_VARS) {
    const partial = { ...MAINNET_ENV };
    delete partial[required];
    await withEnv(partial, async () => {
      assert.throws(
        () => net.getNetworkConfig(),
        (e) => e.message.includes(required) && e.message.includes('ARC_NETWORK=mainnet'),
        `removing ${required} must fail closed`
      );
    });
  }
  // Garbage (non-numeric) chain ID fails closed.
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_CHAIN_ID: 'abc' }, async () => {
    assert.throws(() => net.getNetworkConfig(), /ARC_MAINNET_CHAIN_ID/);
  });
  // Negative CCTP domain fails closed.
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_CCTP_DOMAIN: '-1' }, async () => {
    assert.throws(() => net.getNetworkConfig(), /ARC_MAINNET_CCTP_DOMAIN/);
  });
  // Malformed address fails closed.
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_USDC_ADDRESS: '0x1234' }, async () => {
    assert.throws(() => net.getNetworkConfig(), /ARC_MAINNET_USDC_ADDRESS/);
  });
  // validateNetworkEnv aggregates the failure for startup validation.
  await withEnv({ ARC_NETWORK: 'mainnet' }, async () => {
    const errors = net.validateNetworkEnv();
    assert.ok(errors.length >= 1);
    assert.ok(errors[0].includes('ARC_MAINNET_CHAIN_ID'));
  });
  // Testnet requires nothing mainnet-only.
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.deepEqual(net.validateNetworkEnv(), []);
  });
});

// ── 4. Explorer URL comes from config (helper + migrated modules) ─────────────
test('explorer URLs come from the configured explorer base', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.equal(net.explorerTxUrl('0xabc'), 'https://testnet.arcscan.app/tx/0xabc');
    assert.equal(net.explorerAddressUrl('0xdef'), 'https://testnet.arcscan.app/address/0xdef');
  });
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(net.explorerTxUrl('0xabc'), 'https://arcscan.example/tx/0xabc');
    assert.equal(net.explorerAddressUrl('0xdef'), 'https://arcscan.example/address/0xdef');
  });
  // Production modules consume the config helper (no hardcoded base left).
  for (const f of [
    'src/app/api/payments/nano/settle/route.ts',
    'src/app/api/escrow/release/route.ts',
    'src/app/api/payroll/run/route.ts',
    'src/lib/wallet/transactionResume.ts',
  ]) {
    const src = read(f);
    assert.ok(
      /explorerTxUrl|explorerAddressUrl|explorerBaseUrl/.test(src),
      `${f} must derive explorer URLs from the network config`
    );
    assert.ok(
      !src.includes('https://testnet.arcscan.app'),
      `${f} must not hardcode the testnet explorer base`
    );
  }
});

// ── 5. Chain ID comes from config ─────────────────────────────────────────────
test('chain ID comes from the authoritative config', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.equal(net.getNetworkConfig().chainId, 5042002);
    const chain = net.getArcChain();
    assert.equal(chain.id, 5042002);
    assert.equal(chain.name, 'Arc Testnet');
    assert.equal(chain.testnet, true);
  });
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(net.getNetworkConfig().chainId, 5042001);
    const chain = net.getArcChain();
    assert.equal(chain.id, 5042001);
    assert.equal(chain.name, 'Arc');
    assert.equal(chain.testnet, false);
  });
  // chainClient + wagmi consume the config (no local literal).
  const chainClient = read('src/lib/wallet/chainClient.ts');
  assert.match(chainClient, /export const chainId = getNetworkConfig\(\)\.chainId/);
  assert.ok(!/chainId = 5042002/.test(chainClient));
  const wagmi = read('src/lib/wagmi.ts');
  assert.match(wagmi, /getArcChain\(\)/);
  assert.ok(!/id:\s*5042002/.test(wagmi));
});

// ── 6. Circle blockchain identifier comes from config ─────────────────────────
test('Circle blockchain identifier comes from config', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.equal(net.getNetworkConfig().circleBlockchain, 'ARC-TESTNET');
  });
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(net.getNetworkConfig().circleBlockchain, 'ARC-MAINNET');
  });
  for (const f of [
    'src/lib/circle/client.ts',
    'src/lib/circle/transfers.ts',
    'src/lib/wallet/circleWalletProvisioning.ts',
    'src/app/api/agent/brain/route.ts',
  ]) {
    const src = readCode(f);
    assert.match(src, /getNetworkConfig\(\)\.circleBlockchain/);
    assert.ok(
      !src.includes("'ARC-TESTNET'") && !src.includes('"ARC-TESTNET"'),
      `${f} must not inline the testnet Circle blockchain literal`
    );
  }
});

// ── 7. x402 network/verifier/gateway come from config ─────────────────────────
test('x402 network, verifier and facilitator come from config', async () => {
  const x402 = read('src/lib/x402.ts');
  assert.match(x402, /getNetworkConfig\(\)\.gatewayUrl/);
  assert.match(x402, /net\.x402Network/);
  assert.match(x402, /net\.x402VerifierContract/);
  assert.match(x402, /net\.usdcAddress/);
  assert.ok(!x402.includes('gateway-api-testnet.circle.com'),
    'x402 must not hardcode the testnet facilitator URL');
  const gateway = read('src/app/api/gateway/route.ts');
  assert.match(gateway, /getNetworkConfig\(\)\.gatewayUrl/);
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.x402Network, 'eip155:5042001');
    assert.equal(cfg.x402VerifierContract, A5);
    assert.equal(cfg.gatewayUrl, 'https://gateway-api-mainnet.circle.example');
  });
});

// ── 8. CCTP config comes from config ──────────────────────────────────────────
test('CCTP Iris URL, domain and MessageTransmitter come from config', async () => {
  const cctp = read('src/lib/cctp.ts');
  assert.match(cctp, /getNetworkConfig\(\)\.irisApiUrl/);
  assert.match(cctp, /getNetworkConfig\(\)\.cctpMessageTransmitter/);
  assert.match(cctp, /getNetworkConfig\(\)\.cctpDomain/);
  assert.ok(!cctp.includes('iris-api-sandbox.circle.com'),
    'cctp must not hardcode the sandbox Iris URL');
  const settle = read('src/app/api/payments/settle/route.ts');
  assert.match(settle, /getNetworkConfig\(\)\.irisApiUrl/);
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.irisApiUrl, 'https://iris-api.circle.example/v2');
    assert.equal(cfg.cctpDomain, 27);
    assert.equal(cfg.cctpMessageTransmitter, A1);
  });
});

// ── 9. USDC/EURC are selected from the correct environment ────────────────────
test('USDC/EURC addresses are selected from the configured environment', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.equal(net.getNetworkConfig().usdcAddress, '0x3600000000000000000000000000000000000000');
    assert.equal(net.getNetworkConfig().eurcAddress, '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a');
  });
  await withEnv(MAINNET_ENV, async () => {
    const cfg = net.getNetworkConfig();
    assert.equal(cfg.usdcAddress, A2);
    assert.equal(cfg.eurcAddress, A3);
  });
  const tokens = read('src/lib/tokens/supportedTokens.ts');
  assert.match(tokens, /getNetworkConfig\(\)/);
  // Pinned testnet table values stay byte-exact (verified 2026-08-16).
  assert.match(tokens, /"0x3600000000000000000000000000000000000000"/);
  assert.match(tokens, /"0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"/);
});

// ── 10. ERC-8183 address comes from the correct environment ───────────────────
test('ERC-8183 address comes from the configured environment (canonical pin intact)', async () => {
  await withEnv({ ARC_NETWORK: '' }, async () => {
    assert.equal(net.getNetworkConfig().erc8183Address, '0x0747EEf0706327138c69792bF28Cd525089e4583');
  });
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(net.getNetworkConfig().erc8183Address, A4);
  });
  const erc8183 = read('src/lib/contracts/erc8183.ts');
  const networkSrc = read('src/lib/config/network.ts');
  // The canonical pinned testnet line must stay exactly as the drift test requires.
  assert.ok(
    erc8183.includes("export const AGENTIC_COMMERCE_CONTRACT = '0x0747EEf0706327138c69792bF28Cd525089e4583'"),
    'canonical ERC-8183 testnet pin must stay byte-exact'
  );
  // The authoritative config consumes the canonical pin (no duplicate literal)
  // and must not import erc8183.ts — network.ts must remain client-safe and
  // dependency-free (erc8183.ts stays a pure constants/ABI module).
  assert.match(networkSrc, /erc8183Address: AGENTIC_COMMERCE_CONTRACT/);
  assert.ok(!erc8183.includes('import '), 'erc8183.ts must stay a pure constants/ABI module');
  // The ABI itself is network-independent — mainnet selection must not change it.
  assert.ok(erc8183.includes('export const agenticCommerceAbi'));
});
