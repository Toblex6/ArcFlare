// tests/stream-network-guard.test.mjs — streaming cannot run on the wrong network.
//
// Proves, for the per-network stream guard (src/lib/config/network.ts +
// src/lib/stream/streamGuard.ts):
//   A. mainnet (chain 5042) with NO stream address → requireStreamAddress()
//      throws StreamUnavailableError, the route helper answers HTTP 503, and
//      nothing is broadcast or read (the read helpers throw before any
//      provider/RPC call).
//   B. the Arc TESTNET ArcFlareStream can never be used on mainnet
//      (explicit misconfiguration → 503, never a silent testnet fallback).
//   C. mainnet WITH the verified ARC_MAINNET_STREAM_ADDRESS works.
//   D. testnet keeps working exactly as before (ARCFLARE_STREAM_CONTRACT_ADDRESS,
//      with the legacy ARC_FLARE_STREAM_CONTRACT_ADDRESS spelling honored).
//   E. every stream route gates on streamAddressOr503() BEFORE any
//      transaction-creating / chain-reading / DB call, and no stream route
//      reads the stream env vars directly any more.
//
// Static + unit only: no live chain, no DB, no funds. global fetch is stubbed
// to throw in the runtime cases so any RPC/wallet API attempt fails loudly.
// Run: npx tsx --test tests/stream-network-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const net = await import('../src/lib/config/network.ts');
const guard = await import('../src/lib/stream/streamGuard.ts');
const streamContracts = await import('../src/lib/contracts/streamContract.ts');

const TESTNET_STREAM = '0xd8ca3Bbc212F36666145fAa487D45742eA04A52B';
const MAINNET_STREAM = '0x79230A415dF3B22cD8c7DDB9b7Cd1f860e95375e';

// Self-consistent mainnet environment (chain 5042 = Arc Mainnet). Deliberately
// has NO stream address: that is the fail-closed production default.
const MAINNET_ENV = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC-MAINNET',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://arcscan.example/',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api-mainnet.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: '0x' + '2'.repeat(40),
  ARC_MAINNET_EURC_ADDRESS: '0x' + '3'.repeat(40),
  ARC_MAINNET_X402_VERIFIER: '0x' + '5'.repeat(40),
};

// Ambient `.env` values must not leak into these cases.
const STREAM_ENV_KEYS = [
  'ARCFLARE_STREAM_CONTRACT_ADDRESS',
  'ARC_FLARE_STREAM_CONTRACT_ADDRESS',
  'ARC_MAINNET_STREAM_ADDRESS',
  'ARC_NETWORK',
  'NEXT_PUBLIC_ARC_NETWORK',
];

const withEnv = async (env, fn) => {
  const prev = { ...process.env };
  try {
    for (const k of STREAM_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    net.__resetNetworkConfigCacheForTests();
    await fn();
  } finally {
    for (const k of STREAM_ENV_KEYS) delete process.env[k];
    Object.assign(process.env, prev);
    net.__resetNetworkConfigCacheForTests();
  }
};

const STREAM_ROUTES = [
  'src/app/api/jobs/nanopay/open/route.ts',
  'src/app/api/jobs/nanopay/release/route.ts',
  'src/app/api/jobs/nanopay/close/route.ts',
  'src/app/api/payments/stream/create/route.ts',
  'src/app/api/payments/stream/stop/route.ts',
  'src/app/api/payments/stream/withdraw/route.ts',
];

// Anything that would move funds / touch a wallet, the chain, or the DB
// bookkeeping that must not run on a network with no stream deployment.
const MOVING_CALLS = [
  'createContractTransaction',
  'createContractExecutionTransaction',
  'sendTransaction',
  'writeContract',
  'prisma.erc8183Job.findUnique',
  'prisma.jobNanopaymentStream.findUnique',
  'prisma.stream.findUnique',
  'prisma.stream.count',
  'prisma.stream.create',
];

// ── A. mainnet without a stream address fails closed ────────────────────────
test('mainnet (5042) with no stream address: helper throws, route answers 503', async () => {
  await withEnv(MAINNET_ENV, async () => {
    assert.equal(net.getNetworkConfig().name, 'mainnet');
    assert.equal(net.getNetworkConfig().chainId, 5042);
    assert.equal(net.getNetworkConfig().streamAddress, null);

    assert.throws(
      () => net.requireStreamAddress(),
      (e) => {
        assert.equal(e.name, 'StreamUnavailableError');
        assert.equal(e.code, 'stream_unavailable');
        assert.match(e.message, /Streaming is not available on mainnet/);
        return true;
      }
    );
    assert.equal(net.isStreamAvailable(), false);

    const result = guard.streamAddressOr503();
    assert.ok('response' in result, 'guard must return a 503 response, not an address');
    assert.equal(result.response.status, 503);
    const body = await result.response.json();
    assert.equal(body.error, 'stream_unavailable');
    assert.match(body.message, /Streaming is not available on mainnet/);
  });
});

test('mainnet 503 response never carries a contract address (no testnet fallback)', async () => {
  await withEnv(MAINNET_ENV, async () => {
    const result = guard.streamAddressOr503();
    assert.ok('response' in result);
    assert.ok(!('address' in result), 'no address may be handed out');
    const serialized = JSON.stringify(await result.response.json());
    assert.ok(
      !serialized.toLowerCase().includes(TESTNET_STREAM.toLowerCase()),
      'the testnet stream address must never appear in a mainnet response'
    );
  });
});

test('mainnet read helpers throw before any RPC call (no funds, no network)', async () => {
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args[0]);
    throw new Error('network access attempted on the wrong network');
  };
  try {
    await withEnv(MAINNET_ENV, async () => {
      await assert.rejects(
        () => streamContracts.readStreamOnChain(1n),
        /ArcFlareStream is not usable on this network/
      );
      await assert.rejects(
        () => streamContracts.isTrancheReleasedOnChain(1n, 0),
        /ArcFlareStream is not usable on this network/
      );
      assert.equal(calls.length, 0, 'no RPC/network call may be attempted');
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ── B. an explicitly wrong mainnet configuration fails closed ───────────────
test('mainnet pointed at the testnet stream deployment is rejected (503)', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: TESTNET_STREAM }, async () => {
    assert.throws(
      () => net.requireStreamAddress(),
      (e) => {
        assert.equal(e.name, 'StreamMisconfiguredError');
        assert.match(e.message, /refuses to use the Arc Testnet ArcFlareStream/);
        return true;
      }
    );
    const result = guard.streamAddressOr503();
    assert.ok('response' in result);
    assert.equal(result.response.status, 503);
    const body = await result.response.json();
    assert.equal(body.error, 'stream_misconfigured');
  });
});

test('mainnet with a malformed stream address is rejected (503)', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: 'not-an-address' }, async () => {
    assert.throws(() => net.requireStreamAddress(), /not a valid 0x EVM address/);
    const result = guard.streamAddressOr503();
    assert.ok('response' in result);
    assert.equal(result.response.status, 503);
    const body = await result.response.json();
    assert.equal(body.error, 'stream_misconfigured');
  });
});

test('mainnet ignores both testnet stream variables', async () => {
  await withEnv(
    {
      ...MAINNET_ENV,
      ARCFLARE_STREAM_CONTRACT_ADDRESS: TESTNET_STREAM,
      ARC_FLARE_STREAM_CONTRACT_ADDRESS: TESTNET_STREAM,
    },
    () => {
      assert.equal(
        net.getNetworkConfig().streamAddress,
        null,
        'testnet stream vars must not configure mainnet streaming'
      );
      assert.equal(net.isStreamAvailable(), false);
      assert.throws(() => net.requireStreamAddress(), /Streaming is not available on mainnet/);
    }
  );
});

// ── C. mainnet with the verified address works ──────────────────────────────
test('mainnet WITH the verified ARC_MAINNET_STREAM_ADDRESS resolves it', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: MAINNET_STREAM }, () => {
    assert.equal(net.requireStreamAddress(), MAINNET_STREAM);
    assert.equal(net.isStreamAvailable(), true);
    const result = guard.streamAddressOr503();
    assert.ok('address' in result);
    assert.equal(result.address, MAINNET_STREAM);
  });
});

test('mainnet verified address is case-insensitively accepted and not the testnet one', async () => {
  await withEnv(
    { ...MAINNET_ENV, ARC_MAINNET_STREAM_ADDRESS: MAINNET_STREAM.toLowerCase() },
    () => {
      const resolved = net.requireStreamAddress();
      assert.equal(resolved.toLowerCase(), MAINNET_STREAM.toLowerCase());
      assert.notEqual(resolved.toLowerCase(), TESTNET_STREAM.toLowerCase());
    }
  );
});

// ── D. testnet behavior is unchanged ───────────────────────────────────────
test('testnet resolves ARCFLARE_STREAM_CONTRACT_ADDRESS (unchanged)', async () => {
  await withEnv({ ARC_NETWORK: 'testnet', ARCFLARE_STREAM_CONTRACT_ADDRESS: TESTNET_STREAM }, () => {
    assert.equal(net.getNetworkConfig().name, 'testnet');
    assert.equal(net.getNetworkConfig().streamAddress, TESTNET_STREAM);
    assert.equal(net.isStreamAvailable(), true);
    assert.equal(net.requireStreamAddress(), TESTNET_STREAM);
    const result = guard.streamAddressOr503();
    assert.ok('address' in result);
    assert.equal(result.address, TESTNET_STREAM);
  });
});

test('testnet still honors the legacy ARC_FLARE_STREAM_CONTRACT_ADDRESS spelling', async () => {
  await withEnv({ ARC_NETWORK: 'testnet', ARC_FLARE_STREAM_CONTRACT_ADDRESS: TESTNET_STREAM }, () => {
    assert.equal(net.requireStreamAddress(), TESTNET_STREAM);
  });
});

test('testnet with no stream address fails closed (no invented default)', async () => {
  await withEnv({ ARC_NETWORK: 'testnet' }, async () => {
    assert.throws(
      () => net.requireStreamAddress(),
      /ARCFLARE_STREAM_CONTRACT_ADDRESS is not set/
    );
    const result = guard.streamAddressOr503();
    assert.ok('response' in result);
    assert.equal(result.response.status, 503);
  });
});

// ── E. every stream route is gated before it can move anything ─────────────
// Block comments + import statements are stripped before the ordering scan so
// a mere mention in an import list can't be mistaken for a fund-moving call.
function withoutImportsOrBlockComments(src) {
  const lines = src.split('\n');
  const kept = [];
  let inImport = false;
  let inBlockComment = false;
  for (const line of lines) {
    const t = line.trim();
    if (inBlockComment) {
      if (t.includes('*/')) inBlockComment = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlockComment = true;
      continue;
    }
    if (!inImport && (t.startsWith('import ') || t === 'import')) {
      if (!t.endsWith(';')) inImport = true;
      continue;
    }
    if (inImport) {
      if (t.endsWith(';')) inImport = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

test('all stream routes gate on streamAddressOr503 before any fund/chain/DB call', () => {
  for (const file of STREAM_ROUTES) {
    const src = read(file);
    assert.ok(src.includes('streamAddressOr503'), `${file} must gate on streamAddressOr503()`);
    assert.ok(
      !src.includes('process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS'),
      `${file} must not read process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS directly`
    );
    assert.ok(
      !src.includes('process.env.ARC_FLARE_STREAM_CONTRACT_ADDRESS'),
      `${file} must not read process.env.ARC_FLARE_STREAM_CONTRACT_ADDRESS directly`
    );
    const body = withoutImportsOrBlockComments(src);
    const guardAt = body.indexOf('streamAddressOr503()');
    assert.ok(guardAt > 0, `${file} must call the guard in the handler`);
    for (const call of MOVING_CALLS) {
      const at = body.indexOf(call);
      if (at === -1) continue;
      assert.ok(
        guardAt < at,
        `${file} calls ${call} before the stream network gate — funds could move on the wrong network`
      );
    }
  }
});

test('stream address has a single authority (network config), no env read elsewhere', () => {
  const contracts = read('src/lib/contracts/streamContract.ts');
  assert.ok(
    !contracts.includes('process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS') &&
      !contracts.includes('process.env.ARC_FLARE_STREAM_CONTRACT_ADDRESS'),
    'streamContract must not read the stream env vars directly'
  );
  assert.ok(contracts.includes('requireStreamAddress'), 'streamContract must use the guard');

  const display = read('src/lib/wallet/flarehqContracts.ts');
  assert.ok(
    !display.includes('process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS'),
    'flarehqContracts must not read the stream env var directly'
  );
  assert.ok(display.includes('getNetworkConfig().streamAddress'));

  const envCheck = read('src/lib/env/walletEnvCheck.ts');
  assert.ok(
    envCheck.includes('ARC_MAINNET_STREAM_ADDRESS'),
    'startup validation must require ARC_MAINNET_STREAM_ADDRESS on mainnet'
  );

  const config = read('src/lib/config/network.ts');
  assert.ok(
    config.includes('TESTNET_STREAM_CONTRACT_ADDRESS'),
    'network config must pin the testnet stream deployment for the reject check'
  );
});
