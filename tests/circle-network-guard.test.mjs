// Mock-only tests of the actual signing guards. No Circle API, DB, RPC, keys,
// transactions, wallet creation or sponsorship is performed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Transaction } from 'ethers';
import { parseUnits } from 'viem';
import { createWalletClient, createPublicClient, custom } from 'viem';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';
import {
  assertCircleBlockchain, assertCircleSigningNetwork, CircleNetworkError,
  withCircleNetworkGuard, withCircleBridgeAdapterGuard,
} from '../src/lib/circle/networkGuard.ts';
import { getArcNetworkName, getNetworkConfig } from '../src/lib/config/network.ts';
import { MAINNET_ENV, withEnv } from './fixtures/mainnet-env.mjs';
import { loadTypescript } from './fixtures/load-typescript.mjs';

const ADDRESS = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);
const CHAIN = { chain: 'Arc', chainId: 5042, isTestnet: false, type: 'evm' };
const CONTEXT = { chain: CHAIN, address: ADDRESS };
const methods = [
  'createTransaction', 'createTransferTransaction', 'createContractExecutionTransaction',
  'signTransaction', 'signMessage', 'signTypedData',
];
const networkDependency = { getArcNetworkName, getNetworkConfig };

function fixture(overrides = {}) {
  const calls = [];
  let resource = { id: 'arc-wallet', address: ADDRESS, blockchain: 'ARC', state: 'LIVE', ...overrides };
  const client = {
    async getWallet(input) { calls.push(['getWallet', input]); return { data: { wallet: { ...resource } } }; },
    async listWallets(input) { calls.push(['listWallets', input]); return { data: { wallets: [{ ...resource }] } }; },
    async getTransaction(input) { calls.push(['getTransaction', input]); return { data: { transaction: { id: input.id, walletId: resource.id, blockchain: resource.blockchain } } }; },
  };
  for (const method of [...methods, 'signDelegateAction', 'accelerateTransaction', 'cancelTransaction', 'deriveWallet', 'deriveWalletByAddress', 'createWallets', 'deployContract', 'deployContractTemplate']) {
    client[method] = async (request) => { calls.push([method, request]); return { data: { id: 'mock-transaction' } }; };
  }
  return { client, calls, change: (values) => { resource = { ...resource, ...values }; } };
}
const requestFor = (method) => ({
  walletId: 'arc-wallet',
  ...(method === 'signTransaction' ? { transaction: JSON.stringify({ chainId: 5042, to: OTHER }) } : {}),
  ...(method === 'signTypedData' ? { data: JSON.stringify({ domain: { chainId: 5042 }, message: {} }) } : {}),
});
const rejected = (promise, code = 'WALLET_NETWORK_MISMATCH') => assert.rejects(promise,
  (error) => error instanceof CircleNetworkError && error.code === code && error.status === (code === 'WALLET_CHECK_FAILED' ? 503 : 409));

for (const method of methods) {
  test(`${method}: live Arc wallet reaches the mock once after a fresh read`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture();
    const client = withCircleNetworkGuard(f.client);
    await client[method](requestFor(method));
    await client[method](requestFor(method));
    assert.equal(f.calls.filter(([name]) => name === method).length, 2);
    assert.equal(f.calls.filter(([name]) => name === 'getWallet').length, 2);
    assert.equal(f.calls[0][0], 'getWallet');
  }));
  test(`${method}: an ARC-TESTNET wallet ID never signs`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture({ blockchain: 'ARC-TESTNET' });
    await rejected(withCircleNetworkGuard(f.client)[method](requestFor(method)));
    assert.equal(f.calls.filter(([name]) => name === method).length, 0);
  }));
}

for (const blockchain of [undefined, '', 'ARC-TESTNET', 'ETH-SEPOLIA', 'BASE-SEPOLIA', 'MATIC-AMOY', 'BASE', 'arc']) {
  test(`explicit blockchain ${String(blockchain)} fails closed`, () => withEnv(MAINNET_ENV, () => {
    assert.throws(() => assertCircleBlockchain(blockchain), CircleNetworkError);
  }));
}

for (const overrides of [{ id: 'other-id' }, { address: OTHER }, { address: 'invalid' }, { state: 'FROZEN' }, { state: undefined }, { blockchain: 'BASE' }]) {
  test(`fresh resource mismatch ${JSON.stringify(overrides)} refuses signing`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture(overrides);
    await rejected(assertCircleSigningNetwork(f.client, { walletId: 'arc-wallet', walletAddress: ADDRESS, blockchain: 'ARC' }));
  }));
}

for (const status of [404, 403, 429, 500]) {
  test(`Circle read ${status}: refuses signing with an honest status`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture();
    f.client.getWallet = async () => { throw { response: { status } }; };
    await rejected(withCircleNetworkGuard(f.client).signMessage({ walletId: 'arc-wallet', message: 'offline' }),
      status === 404 ? 'WALLET_NETWORK_MISMATCH' : 'WALLET_CHECK_FAILED');
    assert.equal(f.calls.length, 0);
  }));
}

test('address signing filters exactly one wallet and then re-reads its ID', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture();
  const client = withCircleNetworkGuard(f.client);
  await client.createContractExecutionTransaction({ walletAddress: ADDRESS.toUpperCase().replace('0X', '0x'), blockchain: 'ARC' });
  assert.deepEqual(f.calls.map(([name]) => name), ['listWallets', 'getWallet', 'createContractExecutionTransaction']);
  assert.deepEqual(f.calls[1][1], { id: 'arc-wallet' });
}));

for (const wallets of [[], [{ id: 'testnet', address: ADDRESS, blockchain: 'ARC-TESTNET' }],
  [{ id: 'one', address: ADDRESS, blockchain: 'ARC' }, { id: 'two', address: ADDRESS, blockchain: 'ARC' }]]) {
  test(`address lookup refuses ${wallets.length} ambiguous/foreign matches`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture();
    f.client.listWallets = async () => ({ data: { wallets } });
    await rejected(withCircleNetworkGuard(f.client).signMessage({ walletAddress: ADDRESS, blockchain: 'ARC' }));
    assert.equal(f.calls.length, 0);
  }));
}

for (const input of [
  { transaction: JSON.stringify({ chainId: 5042002 }) }, { transaction: JSON.stringify({ chainId: 8453 }) },
  { transaction: JSON.stringify({ to: OTHER }) }, { transaction: '{invalid' }, { rawTransaction: '0xdead' },
  { rawTransaction: Transaction.from({ type: 2, chainId: 5042002, to: OTHER }).unsignedSerialized },
]) {
  test(`unbound/foreign transaction payload refuses before wallet reads (${Object.keys(input)[0]})`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture();
    await rejected(withCircleNetworkGuard(f.client).signTransaction({ walletId: 'arc-wallet', ...input }));
    assert.equal(f.calls.length, 0);
  }));
}
test('unsigned serialized Arc transaction is accepted by the mocked guard', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture();
  await withCircleNetworkGuard(f.client).signTransaction({ walletId: 'arc-wallet', rawTransaction: Transaction.from({ type: 2, chainId: 5042, to: OTHER }).unsignedSerialized });
  assert.equal(f.calls.at(-1)[0], 'signTransaction');
}));

for (const data of [JSON.stringify({ domain: { chainId: 5042002 } }), JSON.stringify({ domain: { chainId: 'invalid' } }), JSON.stringify({ domain: { name: 'Unbound' } }), '{invalid']) {
  test('foreign/malformed typed data never reaches the mock signer', () => withEnv(MAINNET_ENV, async () => {
    const f = fixture();
    await rejected(withCircleNetworkGuard(f.client).signTypedData({ walletId: 'arc-wallet', data }));
    assert.equal(f.calls.length, 0);
  }));
}
test('opaque delegate action cannot establish an Arc chain binding', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture();
  await rejected(withCircleNetworkGuard(f.client).signDelegateAction({ walletId: 'arc-wallet', unsignedDelegateAction: 'b2ZmbGluZQ==' }));
  assert.equal(f.calls.length, 0);
}));

test('SDK request snapshots identity and nested transfer data across an async lookup', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture();
  let release;
  f.client.getWallet = async () => {
    await new Promise((resolve) => { release = resolve; });
    return { data: { wallet: { id: 'arc-wallet', address: ADDRESS, state: 'LIVE', blockchain: 'ARC' } } };
  };
  const input = { walletId: 'arc-wallet', amounts: ['0.2'], fee: { type: 'level', config: { feeLevel: 'MEDIUM' } } };
  const pending = withCircleNetworkGuard(f.client).createTransaction(input);
  input.walletId = 'testnet-wallet'; input.amounts[0] = '100'; input.fee.config.feeLevel = 'HIGH';
  release(); await pending;
  assert.deepEqual(f.calls[0][1], { walletId: 'arc-wallet', amounts: ['0.2'], fee: { type: 'level', config: { feeLevel: 'MEDIUM' } } });
}));

for (const method of ['accelerateTransaction', 'cancelTransaction']) {
  test(`${method}: re-check transaction and source wallet`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture();
    const client = withCircleNetworkGuard(f.client);
    await client[method]({ id: 'existing-tx' });
    assert.deepEqual(f.calls.map(([name]) => name), ['getTransaction', 'getWallet', method]);
    f.change({ blockchain: 'ARC-TESTNET' });
    await rejected(client[method]({ id: 'existing-tx' }));
    assert.equal(f.calls.filter(([name]) => name === method).length, 1);
  }));
  test(`${method}: unavailable transaction read is 503, not a fallback`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture(); f.client.getTransaction = async () => { throw new Error('offline'); };
    await rejected(withCircleNetworkGuard(f.client)[method]({ id: 'tx' }), 'WALLET_CHECK_FAILED');
    assert.equal(f.calls.length, 0);
  }));
}

test('derivation and provisioning refuse a foreign blockchain before mutation', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); const client = withCircleNetworkGuard(f.client);
  await rejected(client.deriveWallet({ id: 'arc-wallet', blockchain: 'ARC-TESTNET' }));
  await rejected(client.deriveWalletByAddress({ walletAddress: ADDRESS, sourceBlockchain: 'ARC', targetBlockchain: 'BASE' }));
  for (const blockchains of [undefined, [], ['ARC', 'ARC-TESTNET'], ['BASE']]) await rejected(client.createWallets({ blockchains }));
  assert.equal(f.calls.length, 0);
  await client.deriveWallet({ id: 'arc-wallet', blockchain: 'ARC' });
  await client.deriveWalletByAddress({ walletAddress: ADDRESS, sourceBlockchain: 'ARC', targetBlockchain: 'ARC' });
  await client.createWallets({ blockchains: ['ARC'] });
  assert.equal(f.calls.filter(([name]) => ['deriveWallet', 'deriveWalletByAddress', 'createWallets'].includes(name)).length, 3);
}));

test('testnet guard preserves the previous SDK behavior without network lookups', () => withEnv({ ARC_NETWORK: 'testnet' }, async () => {
  const f = fixture({ blockchain: 'ARC-TESTNET' }); const client = withCircleNetworkGuard(f.client);
  for (const method of methods) await client[method]({ walletId: 'testnet-wallet', transaction: '{}' });
  await client.createWallets({ blockchains: ['ETH-SEPOLIA'] });
  assert.equal(f.calls.length, methods.length + 1);
  assert.ok(f.calls.every(([name]) => !['getWallet', 'listWallets'].includes(name)));
}));

for (const method of ['prepare', 'prepareAction', 'signTypedData', 'sendTransaction']) {
  test(`Bridge Kit ${method}: rejects source/testnet contexts before delegation`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture(); let delegated = 0;
    const adapter = withCircleBridgeAdapterGuard({ [method]: async () => { delegated++; return { execute: async () => 'mock' }; } }, f.client);
    for (const chain of ['Arc_Testnet', 'Base', { ...CHAIN, chainId: 5042002 }, { ...CHAIN, isTestnet: true }]) {
      const ctx = { chain, address: ADDRESS };
      const args = method === 'prepareAction' ? ['token.approve', {}, ctx] : method === 'sendTransaction' ? [{}, chain, ADDRESS] : [{ domain: { chainId: 5042 } }, ctx];
      await rejected(adapter[method](...args));
    }
    assert.equal(delegated, 0);
  }));
}

test('prepared Bridge Kit execution performs a fresh wallet read and snapshots context', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let executed = 0;
  const input = { functionName: 'transfer', args: [OTHER, 200000n] };
  const ctx = { chain: { ...CHAIN }, address: ADDRESS };
  const adapter = withCircleBridgeAdapterGuard({ async prepare(params, context) {
    return { async execute() { executed++; assert.equal(context.address, ADDRESS); assert.equal(params.args[1], 200000n); } };
  } }, f.client);
  const request = await adapter.prepare(input, ctx);
  ctx.address = OTHER; ctx.chain.chainId = 5042002; input.args[1] = 999999n;
  await request.execute();
  f.change({ blockchain: 'ARC-TESTNET' });
  await rejected(request.execute());
  assert.equal(executed, 1);
  // The foreign resource is rejected by the execution-time address lookup
  // before its wallet ID can be passed to the signer.
  assert.equal(f.calls.filter(([name]) => name === 'listWallets').length, 3);
  assert.equal(f.calls.filter(([name]) => name === 'getWallet').length, 2);
}));

test('prepared execution rejects identity/chain override bypasses', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let executed = 0;
  const adapter = withCircleBridgeAdapterGuard({ async prepare() { return { async execute() { executed++; } }; } }, f.client);
  const request = await adapter.prepare({}, CONTEXT);
  for (const overrides of [{ account: OTHER }, { chain: { id: 5042002 } }, { chainId: 'invalid' }, { from: OTHER }]) await rejected(request.execute(overrides));
  assert.equal(executed, 0);
}));

test('delegated prepareAction executes through a guarded sub-adapter', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let sent = 0;
  const sub = { async prepareAction(_action, _params, ctx) { return { execute: () => this.sendTransaction({}, ctx.chain, ctx.address) }; },
    async sendTransaction() { sent++; return 'mock-hash'; } };
  const adapter = withCircleBridgeAdapterGuard({ async resolveAdapter() { return sub; },
    async prepareAction(action, params, ctx) { return (await this.resolveAdapter(ctx.chain)).prepareAction(action, params, ctx); } }, f.client);
  const prepared = await adapter.prepareAction('token.approve', {}, CONTEXT);
  f.change({ state: 'FROZEN' });
  await rejected(prepared.execute());
  assert.equal(sent, 0);
  f.change({ state: 'LIVE' });
  await prepared.execute();
  assert.equal(sent, 1);
}));

test('adapter typed-data guard snapshots the full signed message', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let release; let received;
  f.client.listWallets = async () => { await new Promise((resolve) => { release = resolve; }); return { data: { wallets: [{ id: 'arc-wallet', address: ADDRESS, blockchain: 'ARC' }] } }; };
  const adapter = withCircleBridgeAdapterGuard({ async signTypedData(data) { received = data; return 'mock-signature'; } }, f.client);
  const data = { domain: { chainId: 5042 }, message: { amount: 200000n }, types: { Transfer: [{ name: 'amount', type: 'uint256' }] } };
  const pending = adapter.signTypedData(data, CONTEXT);
  data.domain.chainId = 5042002; data.message.amount = 999999n; data.types.Transfer[0].name = 'other';
  release(); await pending;
  assert.equal(received.domain.chainId, 5042); assert.equal(received.message.amount, 200000n); assert.equal(received.types.Transfer[0].name, 'amount');
  await rejected(adapter.signTypedData(data, CONTEXT));
}));

test('getSdk guards nested devc and SCP while preserving read clients', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture({ blockchain: 'ARC-TESTNET' }); let deployed = 0;
  const scp = { async deployContract() { deployed++; }, async queryContract() { return 'read-result'; } };
  const adapter = withCircleBridgeAdapterGuard({ async getSdk() { return { devc: f.client, scp, label: 'offline' }; } }, f.client);
  const sdk = await adapter.getSdk();
  assert.equal(sdk.label, 'offline'); assert.equal(await sdk.scp.queryContract(), 'read-result');
  await rejected(sdk.devc.signMessage({ walletId: 'arc-wallet' }));
  await rejected(sdk.scp.deployContract({ walletId: 'arc-wallet', blockchain: 'ARC' }));
  assert.equal(deployed, 0);
}));

for (const method of ['sendTransaction', 'sendTransactionSync', 'writeContract', 'writeContractSync', 'deployContract', 'signTransaction', 'signMessage', 'signTypedData', 'signAuthorization', 'sendCalls', 'sendCallsSync']) {
  test(`adapter wallet-client ${method} cannot bypass the execution guard`, () => withEnv(MAINNET_ENV, async () => {
    const f = fixture(); let submitted = 0;
    const adapter = withCircleBridgeAdapterGuard({ async initializeWalletClient() { return { [method]: async () => { submitted++; } }; } }, f.client);
    const wallet = await adapter.initializeWalletClient(CHAIN);
    f.change({ blockchain: 'ARC-TESTNET' });
    await rejected(wallet[method]({ account: ADDRESS, domain: { chainId: 5042 } }));
    assert.equal(submitted, 0);
  }));
}
test('wallet-client raw signing/broadcast is blocked while read RPC survives', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let requests = 0;
  const adapter = withCircleBridgeAdapterGuard({ async initializeWalletClient() { return { async request() { requests++; return 'read'; }, async sendRawTransaction() { requests++; } }; } }, f.client);
  const wallet = await adapter.initializeWalletClient(CHAIN);
  assert.equal(await wallet.request({ method: 'eth_chainId' }), 'read');
  await rejected(wallet.request({ method: 'eth_sendTransaction', params: [{}] }));
  await rejected(wallet.request({ method: 'eth_signTypedData_v4', params: [] }));
  await rejected(wallet.sendRawTransaction({ serializedTransaction: '0xdead' }));
  assert.equal(requests, 1);
}));

const VIEM_CHAIN = { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://offline.example'] } } };
function viemFixture() {
  const f = fixture(); const requests = [];
  const provider = { async request(input) { requests.push(input); return input.method === 'eth_chainId' ? '0x13b2' : 'offline-response'; } };
  const wallet = createWalletClient({ chain: VIEM_CHAIN, transport: custom(provider) });
  const publicClient = createPublicClient({ chain: VIEM_CHAIN, transport: custom(provider) });
  const raw = { options: { getWalletClient: () => wallet, getPublicClient: () => publicClient },
    cachedWalletClients: new Map([[5042, wallet]]), walletClientInitPromises: new Map([[5042, Promise.resolve(wallet)]]),
    cachedPublicClients: new Map([[5042, publicClient]]),
    async initializeWalletClient() { return this.options.getWalletClient({ chain: VIEM_CHAIN }); },
    async getPublicClient() { return this.options.getPublicClient({ chain: VIEM_CHAIN }); },
  };
  return { ...f, requests, raw, adapter: withCircleBridgeAdapterGuard(raw, f.client) };
}
test('raw RPC request and transport re-prove wallet identity; reads remain available', () => withEnv(MAINNET_ENV, async () => {
  const f = viemFixture(); const wallet = await f.adapter.initializeWalletClient(CHAIN);
  const send = { method: 'eth_sendTransaction', params: [{ from: ADDRESS, chainId: '0x13b2', to: OTHER }] };
  await wallet.request(send); await wallet.transport.request(send);
  assert.equal(f.requests.length, 2); assert.equal(f.calls.filter(([name]) => name === 'getWallet').length, 2);
  f.change({ state: 'FROZEN' });
  await rejected(wallet.request(send)); await rejected(wallet.transport.request(send));
  await rejected(wallet.transport.request({ method: 'eth_signTypedData_v4', params: [ADDRESS, JSON.stringify({ domain: { chainId: 5042002 } })] }));
  assert.equal(await wallet.transport.request({ method: 'eth_chainId' }), '0x13b2');
  assert.equal(f.requests.length, 3);
}));
test('viem extension cannot capture an unguarded base, transport or second extension', () => withEnv(MAINNET_ENV, async () => {
  const f = viemFixture(); const wallet = await f.adapter.initializeWalletClient(CHAIN); let captured;
  const extended = wallet.extend((base) => { captured = base; return { customSend: (input) => base.request(input) }; });
  const again = extended.extend((base) => ({ transportSend: (input) => base.transport.request(input) }));
  f.change({ blockchain: 'ARC-TESTNET' });
  const input = { method: 'eth_sendTransaction', params: [{ from: ADDRESS }] };
  for (const promise of [captured.request(input), extended.customSend(input), again.transportSend(input)]) await rejected(promise);
  assert.equal(f.requests.length, 0);
}));
test('public clients and extensions cannot add a signing/broadcast edge', () => withEnv(MAINNET_ENV, async () => {
  const f = viemFixture(); const publicClient = await f.adapter.getPublicClient(CHAIN);
  assert.equal(await publicClient.request({ method: 'eth_chainId' }), '0x13b2');
  const extended = publicClient.extend((base) => ({ customWrite: () => base.transport.request({ method: 'eth_sendTransaction', params: [{ from: ADDRESS }] }) }));
  await rejected(extended.customWrite());
  await rejected(publicClient.sendRawTransaction({ serializedTransaction: '0xdead' }));
  assert.equal(f.requests.length, 1);
}));
for (const cache of ['cachedWalletClients', 'walletClientInitPromises', 'cachedPublicClients']) {
  test(`adapter ${cache} exposes only guarded clients through get/values/entries/forEach`, () => withEnv(MAINNET_ENV, async () => {
    const f = viemFixture(); f.change({ blockchain: 'ARC-TESTNET' }); const map = f.adapter[cache]; const clients = [];
    clients.push(await map.get(5042), await map.values().next().value, await map.entries().next().value[1], await [...map][0][1]);
    map.forEach((value, _key, passedMap) => { assert.equal(passedMap, map); clients.push(value); });
    for (const entry of clients) await rejected((await entry).request({ method: 'eth_sendTransaction', params: [{ from: ADDRESS }] }));
    assert.equal(f.requests.length, 0);
  }));
}
test('client options factories retain synchronous shape but cannot leak a raw signer', () => withEnv(MAINNET_ENV, async () => {
  const f = viemFixture(); const wallet = f.adapter.options.getWalletClient({ chain: VIEM_CHAIN });
  const publicClient = f.adapter.options.getPublicClient({ chain: VIEM_CHAIN });
  assert.equal(typeof wallet.then, 'undefined'); assert.equal(typeof publicClient.then, 'undefined');
  f.change({ state: 'FROZEN' });
  await rejected(wallet.request({ method: 'eth_sendTransaction', params: [{ from: ADDRESS }] }));
  await rejected(publicClient.transport.request({ method: 'eth_sendTransaction', params: [{ from: ADDRESS }] }));
  assert.equal(f.requests.length, 0);
}));
test('installed hybrid captured delegation uses guarded factories even when resolveAdapter is skipped', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let signs = 0;
  // Throwaway shape-valid values initialize only SDK objects, never a network request.
  const raw = createCircleWalletsAdapter({ apiKey: 'TEST_API_KEY:offline:offline', entitySecret: '0'.repeat(64) });
  const sub = await raw.options.getAdapterForChain(CHAIN);
  sub.options.getWalletClient = () => ({ chain: VIEM_CHAIN, async signTypedData() { signs++; return 'offline-signature'; } });
  // Installed nested viem version has no Arc mapping; inject only that pure mapping.
  sub.getViemChain = async () => VIEM_CHAIN;
  sub.initializeWalletClient = async function () { return this.options.getWalletClient({ chain: VIEM_CHAIN }); };
  const adapter = withCircleBridgeAdapterGuard(raw, f.client);
  const data = { domain: { name: 'Offline', version: '1', chainId: 5042 }, primaryType: 'Message', types: { Message: [{ name: 'amount', type: 'uint256' }] }, message: { amount: 1n } };
  // Change liveness between the outer check and captured inner SDK signing.
  const readWallet = f.client.getWallet;
  f.client.getWallet = async (input) => {
    const response = await readWallet(input);
    f.change({ state: 'FROZEN' });
    return response;
  };
  await rejected(adapter.signTypedData(data, CONTEXT)); assert.equal(signs, 0);
  assert.equal(f.calls.filter(([name]) => name === 'getWallet').length, 2, 'captured client re-reads the now-frozen wallet');
  const optionsSub = await adapter.options.getAdapterForChain(CHAIN);
  for (const entry of [optionsSub, adapter.adapterCache.set('evm', sub).get('evm'), [...adapter.adapterCache.values()][0]]) {
    await rejected(entry.sendTransaction({}, { ...CHAIN, chainId: 5042002 }, ADDRESS));
  }
  assert.equal(signs, 0);
}));
test('direct prepare helpers and action registry handlers cannot escape execution-time liveness', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture(); let signs = 0; const prepared = () => ({ async execute() { signs++; } });
  const adapter = withCircleBridgeAdapterGuard({ prepareNativeTransfer: prepared, prepareStateChangingFunction: prepared,
    actionRegistry: { actionHandlers: new Map([['token.approve', prepared]]), async executeAction() { return prepared(); } },
  }, f.client);
  const requests = [await adapter.prepareNativeTransfer(OTHER, 1n, CHAIN, ADDRESS),
    await adapter.prepareStateChangingFunction({}, {}, CHAIN, ADDRESS),
    await adapter.actionRegistry.executeAction('token.approve', {}, CONTEXT),
    await adapter.actionRegistry.actionHandlers.get('token.approve')({}, CONTEXT)];
  f.change({ state: 'FROZEN' }); for (const request of requests) await rejected(request.execute());
  assert.equal(signs, 0);
}));
test('SDK private generated clients are not exposed by the shared proxy', () => withEnv(MAINNET_ENV, () => {
  const client = withCircleNetworkGuard({ params: { client: { signMessage() { throw new Error('raw API'); } } } });
  assert.equal(client.params, undefined);
}));
test('foreign or unbound authorization-list payloads fail before wallet signing', () => withEnv(MAINNET_ENV, async () => {
  const f = viemFixture(); const wallet = await f.adapter.initializeWalletClient(CHAIN);
  for (const chainId of [0, 5042002, undefined, 'invalid']) await rejected(wallet.sendTransaction({ account: ADDRESS, authorizationList: [{ chainId }] }));
  assert.equal(f.requests.length, 0);
}));
test('testnet raw request, client extension and guarded caches preserve prior behavior', () => withEnv({ ARC_NETWORK: 'testnet' }, async () => {
  const f = viemFixture(); const wallet = f.adapter.options.getWalletClient({ chain: VIEM_CHAIN });
  const extended = wallet.extend((base) => ({ oldWrite: () => base.transport.request({ method: 'eth_sendTransaction', params: [{}] }) }));
  await extended.oldWrite(); await (await f.adapter.cachedWalletClients.get(5042)).request({ method: 'eth_signTypedData_v4', params: [] });
  assert.equal(f.requests.length, 2); assert.equal(f.calls.length, 0);
}));
test('unbound adapter batch execution is refused on mainnet and preserved on testnet', async () => {
  const f = fixture(); let calls = 0;
  const adapter = withCircleBridgeAdapterGuard({ async batchExecute() { calls++; } }, f.client);
  await withEnv(MAINNET_ENV, () => rejected(adapter.batchExecute([])));
  await withEnv({ ARC_NETWORK: 'testnet' }, () => adapter.batchExecute([]));
  assert.equal(calls, 1);
});

test('transfer helper never falls back after a network refusal', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture({ blockchain: 'ARC-TESTNET' });
  const transfers = loadTypescript('src/lib/circle/transfers.ts', {
    viem: { parseUnits }, './client': { getCircleClient: () => withCircleNetworkGuard(f.client) },
    './networkGuard': { assertCircleSigningNetwork, CircleNetworkError }, '@/lib/config/network': networkDependency,
  });
  await rejected(transfers.createCircleTransfer({ walletId: 'arc-wallet', walletAddress: ADDRESS, destinationAddress: OTHER, amount: '0.2' }));
  assert.ok(f.calls.every(([name]) => !['createTransaction', 'createContractExecutionTransaction'].includes(name)));
}));
test('a later native network refusal cannot be converted to address fallback', () => withEnv(MAINNET_ENV, async () => {
  const f = fixture();
  f.client.createTransaction = async () => { throw new CircleNetworkError('WALLET_CHECK_FAILED', 503); };
  const transfers = loadTypescript('src/lib/circle/transfers.ts', {
    viem: { parseUnits }, './client': { getCircleClient: () => f.client },
    './networkGuard': { assertCircleSigningNetwork, CircleNetworkError }, '@/lib/config/network': networkDependency,
  });
  await rejected(transfers.createCircleTransfer({ walletId: 'arc-wallet', walletAddress: ADDRESS, destinationAddress: OTHER, amount: '0.2' }), 'WALLET_CHECK_FAILED');
  assert.equal(f.calls.filter(([name]) => name === 'createContractExecutionTransaction').length, 0);
}));

test('Gas Station mainnet sponsorship resolves neither database nor relayer', () => withEnv(MAINNET_ENV, async () => {
  let reads = 0; let signers = 0; let writes = 0;
  const provisioning = loadTypescript('src/lib/wallet/circleWalletProvisioning.ts', {
    crypto: { randomUUID: () => 'offline-uuid' }, '@/lib/circle/client': { getCircleClient: () => { throw new Error('Unexpected wallet API'); } },
    '@/lib/circle/networkGuard': { assertCircleBlockchain }, '@/lib/config/network': networkDependency,
    '@/lib/prisma': { prisma: { consumerAccount: { async findFirst() { reads++; return { walletAddress: ADDRESS }; } } } },
    '@/lib/wallet/jobEscrowClient': { getRelayerSigner: () => { signers++; return { async sendTransaction() { writes++; } }; } },
  });
  assert.equal(await provisioning.retryGasSponsorship('offline-user'), null);
  assert.equal(reads, 0); assert.equal(signers, 0); assert.equal(writes, 0);
  // Existing-account path must not create/re-provision a wallet either.
  await provisioning.provisionWalletForTelegramUser('offline-user', 'Offline');
  assert.equal(reads, 1); assert.equal(signers, 0); assert.equal(writes, 0);
}));

test('all production DCW factories use the shared guarded factory', () => {
  const root = new URL('../src/', import.meta.url);
  const files = [
    'app/api/agent/deploy/route.ts', 'app/api/agent/deploy/recover/route.ts', 'app/api/agent/reputation/route.ts',
    'app/api/agent/validation/route.ts', 'app/api/escrow/create/route.ts', 'app/api/escrow/dispute/route.ts',
    'app/api/escrow/refund/route.ts', 'app/api/escrow/release/route.ts', 'app/api/jobs/route.ts',
    'app/api/jobs/[jobId]/validation/request/route.ts', 'app/api/jobs/[jobId]/validation/respond/route.ts',
    'app/api/payments/nano/settle/route.ts', 'app/api/payments/scheduled/run/route.ts', 'app/api/payments/settle/route.ts',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, root), 'utf8');
    assert.ok(source.includes("createCircleClient as initiateDeveloperControlledWalletsClient"), file);
    assert.ok(!source.includes("from '@circle-fin/developer-controlled-wallets'"), file);
  }
});
