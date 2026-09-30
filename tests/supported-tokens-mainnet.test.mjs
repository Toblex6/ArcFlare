// tests/supported-tokens-mainnet.test.mjs
//
// NETWORK ISOLATION regression (promoted P2, pre-mainnet fix):
//   ARC_NETWORK=mainnet + testnet token address => NOT SUPPORTED.
//
// getTokenByAddress() must never fall back to the testnet-pinned
// SUPPORTED_TOKENS table when mainnet is selected ("no mainnet path may
// silently use testnet configuration"). Testnet behavior is unchanged.
//
// Run: npx tsx --test tests/supported-tokens-mainnet.test.mjs
// (tsx because the module under test is TypeScript with extensionless
// relative imports — same reason as tests/network-config.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const net = await import('../src/lib/config/network.ts');
const tokens = await import('../src/lib/tokens/supportedTokens.ts');

// Testnet pins (must NEVER resolve on mainnet unless explicitly configured).
const TESTNET_USDC = '0x3600000000000000000000000000000000000000';
const TESTNET_EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const TESTNET_CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';

// Full mainnet env with token addresses DISTINCT from every testnet pin, so
// the testnet-fallback path (if present) would be observable.
const A_USDC = '0x' + 'a'.repeat(40);
const A_EURC = '0x' + 'b'.repeat(40);
const MAINNET_ENV = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://arcscan.example',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api-mainnet.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: A_USDC,
  ARC_MAINNET_EURC_ADDRESS: A_EURC,
  ARC_MAINNET_ERC8183_ADDRESS: '0x' + '4'.repeat(40),
  ARC_MAINNET_X402_VERIFIER: '0x' + '5'.repeat(40),
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

test('mainnet: testnet token addresses are NOT SUPPORTED', async () => {
  await withEnv(MAINNET_ENV, async () => {
    for (const addr of [TESTNET_USDC, TESTNET_EURC, TESTNET_CIRBTC]) {
      assert.equal(
        tokens.getTokenByAddress(addr),
        undefined,
        `${addr} must not resolve on mainnet`
      );
      assert.equal(tokens.isSupportedToken(addr), false, `${addr} must not be supported on mainnet`);
    }
  });
});

test('mainnet: explicitly configured mainnet tokens still resolve', async () => {
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(tokens.getTokenByAddress(A_USDC)?.symbol, 'USDC');
    assert.equal(tokens.getTokenByAddress(A_EURC)?.symbol, 'EURC');
    assert.equal(tokens.isSupportedToken(A_USDC), true);
    assert.equal(tokens.getTokenBySymbol('USDC').address, A_USDC);
    assert.equal(tokens.getTokenBySymbol('EURC').address, A_EURC);
  });
});

test('mainnet: cirBTC resolves to the docs pin (testnet pin stays dead)', async () => {
  // docs.arc.io/arc/references/contract-addresses (verified live 2026-09-30):
  // mainnet cirBTC 0x171A… (8 decimals) with live UnitFlow factory pools.
  // The old testnet-only refusal was the Swap-page 500.
  const MAINNET_CIRBTC = '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0';
  await withEnv(MAINNET_ENV, async () => {
    const cir = tokens.getTokenBySymbol('CIRBTC');
    assert.equal(cir.address, MAINNET_CIRBTC);
    assert.equal(cir.decimals, 8);
    assert.equal(tokens.getTokenByAddress(MAINNET_CIRBTC)?.symbol, 'CIRBTC');
    assert.equal(tokens.isSupportedToken(MAINNET_CIRBTC), true);
    // The testnet cirBTC pin must NOT resolve on mainnet (isolation holds).
    assert.equal(tokens.getTokenByAddress(TESTNET_CIRBTC), undefined);
  });
});

test('mainnet: malformed cirBTC override fails closed (never testnet fallback)', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_CIRBTC_ADDRESS: 'not-an-address' }, async () => {
    assert.throws(() => tokens.getTokenBySymbol('CIRBTC'), /ARC_MAINNET_CIRBTC_ADDRESS must be a 0x EVM address/);
  });
});

test('mainnet: real-world shape where mainnet USDC equals the testnet address still resolves', async () => {
  // Per .env.example the mainnet USDC interface IS 0x3600… (set explicitly).
  // That row resolves through the environment-selected loop — not the
  // testnet fallback — while the UNCONFIGURED testnet EURC pin stays dead.
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_USDC_ADDRESS: TESTNET_USDC }, async () => {
    assert.equal(tokens.getTokenByAddress(TESTNET_USDC)?.symbol, 'USDC');
    assert.equal(tokens.getTokenByAddress(TESTNET_EURC), undefined);
    assert.equal(tokens.getTokenByAddress(TESTNET_CIRBTC), undefined);
  });
});

test('testnet: current behavior unchanged', async () => {
  await withEnv({ ARC_NETWORK: 'testnet' }, async () => {
    assert.equal(tokens.getTokenByAddress(TESTNET_USDC)?.symbol, 'USDC');
    assert.equal(tokens.getTokenByAddress(TESTNET_EURC)?.symbol, 'EURC');
    assert.equal(tokens.getTokenByAddress(TESTNET_CIRBTC)?.symbol, 'CIRBTC');
    assert.equal(tokens.isSupportedToken(TESTNET_USDC), true);
    assert.equal(tokens.getTokenByAddress('0xDeaDbeefdEadbeefdEadbeefdEadbeefdEadbeef'), undefined);
  });
});
