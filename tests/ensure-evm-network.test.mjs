// Behavioral wallet-network switching tests. Mock providers only: no RPC,
// wallet prompt, signing, broadcasting, browser automation or funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureEvmNetwork } from '../src/lib/wallet/ensureEvmNetwork.ts';

const CHAIN = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
  blockExplorers: { default: { name: 'BaseScan', url: 'https://basescan.org' } },
};

function providerFixture(initial = 1) {
  let chainId = initial;
  const calls = [];
  const provider = { async request(input) {
    calls.push(structuredClone(input));
    if (input.method === 'eth_chainId') return `0x${chainId.toString(16)}`;
    if (input.method === 'wallet_switchEthereumChain') { chainId = Number(BigInt(input.params[0].chainId)); return null; }
    if (input.method === 'wallet_addEthereumChain') return null;
    throw new Error(`Unexpected ${input.method}`);
  } };
  return { provider, calls, setChain: (id) => { chainId = id; } };
}

test('live provider chain wins over a stale matching hook snapshot', async () => {
  const f = providerFixture(1); let switches = 0;
  const result = await ensureEvmNetwork({ chain: CHAIN, chainId: CHAIN.id,
    getProvider: async () => f.provider,
    switchChainAsync: async () => { switches++; f.setChain(CHAIN.id); },
  });
  assert.deepEqual(result, { ok: true }); assert.equal(switches, 1);
  assert.equal(f.calls.filter(({ method }) => method === 'eth_chainId').length, 2);
});

test('ChainNotConfiguredError uses the same active provider and verifies its result', async () => {
  const f = providerFixture(1); let wagmiCalls = 0;
  const error = Object.assign(new Error('Chain not configured'), { name: 'ChainNotConfiguredError' });
  const result = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
    getProvider: async () => f.provider,
    switchChainAsync: async () => { wagmiCalls++; throw error; },
  });
  assert.deepEqual(result, { ok: true }); assert.equal(wagmiCalls, 1);
  assert.equal(f.calls.filter(({ method }) => method === 'wallet_switchEthereumChain').length, 1);
});

test('unknown chain adds official metadata, switches, and verifies', async () => {
  const f = providerFixture(1); let switches = 0; let added = false;
  f.provider.request = async (input) => {
    f.calls.push(structuredClone(input));
    if (input.method === 'eth_chainId') return `0x${(added ? CHAIN.id : 1).toString(16)}`;
    if (input.method === 'wallet_addEthereumChain') { added = true; return null; }
    throw new Error(`Unexpected ${input.method}`);
  };
  const unknown = Object.assign(new Error('Unrecognized chain'), { code: 4902 });
  const result = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
    getProvider: async () => f.provider,
    switchChainAsync: async () => { switches++; throw unknown; },
  });
  assert.deepEqual(result, { ok: true }); assert.equal(switches, 1);
  const add = f.calls.find(({ method }) => method === 'wallet_addEthereumChain');
  assert.deepEqual(add.params[0], {
    chainId: '0x2105', chainName: 'Base', nativeCurrency: CHAIN.nativeCurrency,
    rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'],
  });
});

test('adding without switching is never reported as success', async () => {
  const f = providerFixture(1); let switchCalls = 0; let addCalls = 0;
  const unknown = Object.assign(new Error('Unknown chain'), { code: 4902 });
  f.provider.request = async (input) => {
    f.calls.push(structuredClone(input));
    if (input.method === 'eth_chainId') return '0x1';
    if (input.method === 'wallet_addEthereumChain') { addCalls++; return null; }
    throw new Error(`Unexpected ${input.method}`);
  };
  const result = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
    getProvider: async () => f.provider,
    switchChainAsync: async () => { switchCalls++; throw switchCalls === 1 ? unknown : Object.assign(new Error('User rejected'), { code: 4001 }); },
  });
  assert.equal(result.ok, false); assert.equal(result.reason, 'REJECTED');
  assert.equal(addCalls, 1); assert.equal(switchCalls, 2);
});

test('active connector failure never falls back to window.ethereum', async () => {
  const original = globalThis.window; let fallbackCalls = 0; let switches = 0;
  globalThis.window = { ethereum: { async request() { fallbackCalls++; return '0x2105'; } } };
  try {
    const result = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
      getProvider: async () => { throw new Error('WalletConnect disconnected'); },
      switchChainAsync: async () => { switches++; },
    });
    assert.equal(result.ok, false); assert.equal(result.reason, 'GENERIC');
    assert.equal(fallbackCalls, 0); assert.equal(switches, 0);
  } finally { globalThis.window = original; }
});

test('wrong live chain after a claimed switch fails closed', async () => {
  const f = providerFixture(1);
  const result = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
    getProvider: async () => f.provider,
    switchChainAsync: async () => {},
  });
  assert.deepEqual(result, { ok: false, reason: 'UNSUPPORTED', message: 'Switch your wallet to Base to continue.' });
});

test('provider rejection and malformed live chain return friendly failures', async () => {
  const rejectedProvider = { async request({ method }) {
    if (method === 'eth_chainId') return '0x1';
    throw Object.assign(new Error('User denied request'), { code: 4001 });
  } };
  const rejected = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
    getProvider: async () => rejectedProvider,
    switchChainAsync: async () => { throw Object.assign(new Error('User denied request'), { code: 4001 }); },
  });
  assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'REJECTED');
  const malformed = await ensureEvmNetwork({ chain: CHAIN, chainId: 1,
    getProvider: async () => ({ request: async () => 'not-a-chain' }), switchChainAsync: async () => {},
  });
  assert.equal(malformed.ok, false); assert.equal(malformed.reason, 'GENERIC');
});
