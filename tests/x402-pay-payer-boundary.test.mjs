// Real route compiled with explicitly offline dependencies: no DB, RPC or signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './fixtures/load-typescript.mjs';

function fixture({ available = true, merchant = { id: 'offline-merchant' }, actor = null } = {}) {
  const calls = [];
  const wallet = { address: '0x' + '2'.repeat(40), privateKey: 'offline-not-a-signing-key' };
  class GatewayClient {
    constructor(options) {
      calls.push('client');
      assert.equal(options.chain, 'arc');
      assert.equal(options.privateKey, wallet.privateKey);
    }
    async getBalances() { return { gateway: { formattedAvailable: '1' } }; }
    async pay() {
      calls.push('pay');
      return { transaction: 'offline-proof', formattedAmount: '0.01', data: {} };
    }
  }
  const route = loadTypescript('src/app/api/x402/pay/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@circle-fin/x402-batching/client': { GatewayClient },
    '@/lib/middleware/withMerchantAuth': {
      withApiKeyOrMerchant: (handler) => handler,
      resolveMerchant: async () => { calls.push('merchant'); return merchant; },
    },
    '@/lib/x402-wallet': {
      getOrCreateBuyerWallet: async (id) => { calls.push('wallet'); assert.equal(id, merchant.id); return wallet; },
    },
    '@/lib/x402-gateway': {
      isGatewayAvailable: () => available,
      requireGatewayChain: () => 'arc',
      gatewayUnavailableBody: () => ({ success: false, code: 'gateway_mainnet_unavailable' }),
    },
    '@/lib/config/network': { getNetworkConfig: () => ({ primaryRpc: 'https://offline.invalid' }) },
    '@/lib/wallet/verifyCallerControlsAddress': {
      verifyCallerControlsAddress: async (_req, address) => {
        calls.push('control');
        assert.equal(address, wallet.address);
        return actor;
      },
    },
  }, {
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => { calls.push('probe'); return new Response(null, { status: 402 }); },
  });
  const req = {
    nextUrl: { origin: 'https://offline.invalid' },
    json: async () => { calls.push('body'); return { resourceUrl: '/protected' }; },
  };
  return { route, req, calls, wallet };
}

test('disabled Gateway refuses before body, identity or payer resolution', async () => {
  const { route, req, calls } = fixture({ available: false });
  assert.equal((await route.POST(req)).status, 503);
  assert.deepEqual(calls, []);
});

test('service key without merchant identity cannot use any shared payer', async () => {
  const { route, req, calls } = fixture({ merchant: null });
  assert.equal((await route.POST(req)).status, 403);
  assert.deepEqual(calls, ['body', 'merchant']);
});

test('failed ownership check refuses before SDK construction, probe or payment', async () => {
  const { route, req, calls } = fixture();
  assert.equal((await route.POST(req)).status, 403);
  assert.deepEqual(calls, ['body', 'merchant', 'wallet', 'control']);
});

test('controlled merchant EOA is the only payer passed to the offline SDK', async () => {
  const { route, req, calls, wallet } = fixture({ actor: { type: 'merchant', id: 'offline-merchant' } });
  const response = await route.POST(req);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).paidWith, wallet.address);
  assert.deepEqual(calls, ['body', 'merchant', 'wallet', 'control', 'client', 'probe', 'pay']);
});
