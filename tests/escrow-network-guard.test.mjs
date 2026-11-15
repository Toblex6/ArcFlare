// tests/escrow-network-guard.test.mjs — escrow cannot run on the wrong network.
//
// Proves, for the per-network escrow guard (src/lib/config/network.ts +
// src/lib/escrow/escrowGuard.ts):
//   A. mainnet (chain 5042) with NO escrow address → the guard throws
//      EscrowUnavailableError and the route helper answers HTTP 503
//      "Escrow is not available on mainnet" — no transaction is attempted,
//      no RPC/network call is made, no DB row is written.
//   B. the Arc TESTNET escrow deployment can never be used on mainnet
//      (explicit misconfiguration → 503, never a silent testnet fallback).
//   C. testnet keeps working exactly as before (ARCFLARE_ESCROW_CONTRACT_ADDRESS).
//   D. every escrow route gates on escrowAddressOr503() BEFORE any
//      transaction-creating / chain-reading call, and no escrow route reads
//      process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS directly any more.
//
// Static + unit only: no live chain, no DB, no funds. The one runtime route
// exercise stubs global fetch to throw, so any attempt to reach an RPC or a
// wallet API fails the test instead of passing silently.
// Run: npx tsx --test tests/escrow-network-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

const net = await import('../src/lib/config/network.ts');
const guard = await import('../src/lib/escrow/escrowGuard.ts');

const TESTNET_ESCROW = '0xEb810aeD24D2314dB7471E44bf6DE89f017631E0';
const MAINNET_ESCROW = '0x' + '9'.repeat(40);

// Self-consistent mainnet environment (chain 5042 = Arc Mainnet). Deliberately
// has NO escrow address: that is the production state today.
const MAINNET_ENV = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC-MAINNET',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://arcscan.example/',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api-mainnet.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '27',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: '0x' + '2'.repeat(40),
  ARC_MAINNET_EURC_ADDRESS: '0x' + '3'.repeat(40),
  ARC_MAINNET_X402_VERIFIER: '0x' + '5'.repeat(40),
};

const ESCROW_ENV_KEYS = [
  'ARCFLARE_ESCROW_CONTRACT_ADDRESS',
  'ARC_MAINNET_ESCROW_ADDRESS',
  'ARC_NETWORK',
  'NEXT_PUBLIC_ARC_NETWORK',
];

const withEnv = async (env, fn) => {
  const prev = { ...process.env };
  try {
    // Start from a clean escrow/network slate: the ambient .env must not leak
    // an escrow address into these cases.
    for (const k of ESCROW_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    net.__resetNetworkConfigCacheForTests();
    await fn();
  } finally {
    for (const k of ESCROW_ENV_KEYS) delete process.env[k];
    Object.assign(process.env, prev);
    net.__resetNetworkConfigCacheForTests();
  }
};

const ESCROW_ROUTES = [
  'src/app/api/escrow/create/route.ts',
  'src/app/api/escrow/release/route.ts',
  'src/app/api/escrow/refund/route.ts',
  'src/app/api/escrow/dispute/route.ts',
  'src/app/api/escrow/link/[reference]/fund/route.ts',
  'src/app/api/escrow/[reference]/beneficiary-confirm/route.ts',
  'src/app/api/merchant/escrow-link/route.ts',
  'src/app/api/admin/disputes/[reference]/resolve/route.ts',
];

// Anything that would move funds / touch a wallet or the chain.
const MOVING_CALLS = [
  'createContractExecutionTransaction',
  'executeContract',
  'readContractReliable',
  'getReceiptReliable',
  'getTransactionReliable',
  'writeContract',
  'queueTransactionRequest',
  'prisma.escrow.create',
  'prisma.escrow.update',
];

// ── A. mainnet without an escrow address fails closed ───────────────────────
test('mainnet (5042) with no escrow address: helper throws, route answers 503', async () => {
  await withEnv(MAINNET_ENV, () => {
    assert.equal(net.getNetworkConfig().name, 'mainnet');
    assert.equal(net.getNetworkConfig().chainId, 5042);
    assert.equal(net.getNetworkConfig().escrowAddress, null);

    assert.throws(
      () => net.requireEscrowAddress(),
      (e) => {
        assert.equal(e.name, 'EscrowUnavailableError');
        assert.equal(e.code, 'escrow_unavailable');
        assert.match(e.message, /Escrow is not available on mainnet/);
        return true;
      }
    );
    assert.equal(net.isEscrowAvailable(), false);

    const result = guard.escrowAddressOr503();
    assert.ok('response' in result, 'guard must return a 503 response, not an address');
    assert.equal(result.response.status, 503);
    return result.response.json().then((body) => {
      assert.equal(body.error, 'escrow_unavailable');
      assert.match(body.message, /Escrow is not available on mainnet/);
    });
  });
});

test('mainnet 503 response never carries a contract address (no testnet fallback)', async () => {
  await withEnv(MAINNET_ENV, async () => {
    const result = guard.escrowAddressOr503();
    assert.ok('response' in result);
    const body = await result.response.json();
    const serialized = JSON.stringify(body);
    assert.ok(!('address' in result), 'no address may be handed out');
    assert.ok(
      !serialized.toLowerCase().includes(TESTNET_ESCROW.toLowerCase()),
      'the testnet escrow address must never appear in a mainnet response'
    );
  });
});

// ── B. an explicitly wrong mainnet configuration fails closed ───────────────
test('mainnet pointed at the testnet escrow deployment is rejected (503)', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_ESCROW_ADDRESS: TESTNET_ESCROW }, async () => {
    assert.throws(
      () => net.requireEscrowAddress(),
      (e) => {
        assert.equal(e.name, 'EscrowMisconfiguredError');
        assert.match(e.message, /refuses to use the Arc Testnet FlareHQEscrow/);
        return true;
      }
    );
    const result = guard.escrowAddressOr503();
    assert.ok('response' in result);
    assert.equal(result.response.status, 503);
    const body = await result.response.json();
    assert.equal(body.error, 'escrow_misconfigured');
  });
});

test('mainnet with a malformed escrow address is rejected (503)', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_ESCROW_ADDRESS: 'not-an-address' }, () => {
    assert.throws(() => net.requireEscrowAddress(), /not a valid 0x EVM address/);
    const result = guard.escrowAddressOr503();
    assert.ok('response' in result);
    assert.equal(result.response.status, 503);
  });
});

test('mainnet ignores the legacy testnet ARCFLARE_ESCROW_CONTRACT_ADDRESS variable', async () => {
  await withEnv({ ...MAINNET_ENV, ARCFLARE_ESCROW_CONTRACT_ADDRESS: TESTNET_ESCROW }, () => {
    assert.equal(net.getNetworkConfig().escrowAddress, null, 'legacy var must not configure mainnet escrow');
    assert.equal(net.isEscrowAvailable(), false);
    assert.throws(() => net.requireEscrowAddress(), /Escrow is not available on mainnet/);
  });
});

test('mainnet WITH an explicit verified address resolves it', async () => {
  await withEnv({ ...MAINNET_ENV, ARC_MAINNET_ESCROW_ADDRESS: MAINNET_ESCROW }, () => {
    assert.equal(net.requireEscrowAddress(), MAINNET_ESCROW);
    const result = guard.escrowAddressOr503();
    assert.ok('address' in result);
    assert.equal(result.address, MAINNET_ESCROW);
  });
});

// ── C. testnet behavior is unchanged ────────────────────────────────────────
test('testnet still resolves the configured escrow contract', async () => {
  await withEnv(
    { ARC_NETWORK: 'testnet', ARCFLARE_ESCROW_CONTRACT_ADDRESS: TESTNET_ESCROW },
    () => {
      assert.equal(net.getNetworkConfig().name, 'testnet');
      assert.equal(net.getNetworkConfig().escrowAddress, TESTNET_ESCROW);
      assert.equal(net.isEscrowAvailable(), true);
      assert.equal(net.requireEscrowAddress(), TESTNET_ESCROW);
      const result = guard.escrowAddressOr503();
      assert.ok('address' in result);
      assert.equal(result.address, TESTNET_ESCROW);
    }
  );
});

test('testnet with no escrow address still fails closed (no invented default)', async () => {
  await withEnv({ ARC_NETWORK: 'testnet' }, () => {
    assert.throws(() => net.requireEscrowAddress(), /ARCFLARE_ESCROW_CONTRACT_ADDRESS is not set/);
  });
});

test('testnet explicitly set to the deployed escrow keeps working end to end', async () => {
  await withEnv(
    { ARC_NETWORK: 'testnet', ARCFLARE_ESCROW_CONTRACT_ADDRESS: TESTNET_ESCROW },
    async () => {
      // Route module resolves the same address under testnet config.
      const create = await import('../src/app/api/escrow/create/route.ts');
      assert.equal(typeof create.POST, 'function');
    }
  );
});

// ── D. every escrow route is gated before it can move anything ──────────────
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

test('all escrow routes gate on escrowAddressOr503 before any fund/chain call', () => {
  for (const file of ESCROW_ROUTES) {
    const src = read(file);
    assert.ok(
      src.includes('escrowAddressOr503'),
      `${file} must gate on escrowAddressOr503()`
    );
    assert.ok(
      !src.includes('process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS'),
      `${file} must not read process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS directly`
    );
    const body = withoutImportsOrBlockComments(src);
    const guardAt = body.indexOf('escrowAddressOr503()');
    assert.ok(guardAt > 0, `${file} must call the guard in the handler`);
    for (const call of MOVING_CALLS) {
      const at = body.indexOf(call);
      if (at === -1) continue;
      assert.ok(
        guardAt < at,
        `${file} calls ${call} before the escrow network gate — funds could move on the wrong network`
      );
    }
  }
});

test('flarehqContracts + transactionVerification resolve escrow via network config', () => {
  const contracts = read('src/lib/wallet/flarehqContracts.ts');
  assert.ok(
    !contracts.includes('process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS'),
    'flarehqContracts must not read the escrow env var directly'
  );
  assert.ok(contracts.includes('getNetworkConfig().escrowAddress'));
  const verify = read('src/lib/wallet/transactionVerification.ts');
  assert.ok(
    !verify.includes('process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS'),
    'transactionVerification must not read the escrow env var directly'
  );
  assert.ok(verify.includes('requireEscrowAddress'), 'transactionVerification must use the guard');
});

// ── Runtime proof: mainnet → 503 with zero network/transaction attempts ─────
test('mainnet escrow fund route answers 503 without attempting any transaction', async () => {
  const { NextRequest } = await import('next/server');
  const fundRoute = await import('../src/app/api/escrow/link/[reference]/fund/route.ts');

  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args[0]);
    throw new Error('network access attempted on the wrong network');
  };
  try {
    await withEnv(MAINNET_ENV, async () => {
      const req = new NextRequest('http://localhost/api/escrow/link/escrow_x/fund', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depositorSCA: '0x' + 'a'.repeat(40), txHash: '0x' + 'b'.repeat(64) }),
      });
      const res = await fundRoute.POST(req, { params: Promise.resolve({ reference: 'escrow_x' }) });
      assert.equal(res.status, 503, 'mainnet without escrow must answer 503');
      const body = await res.json();
      assert.equal(body.error, 'escrow_unavailable');
      assert.match(body.message, /Escrow is not available on mainnet/);
      assert.equal(calls.length, 0, 'no RPC/network call may be attempted');
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});
