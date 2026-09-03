// scripts/wallet-ux-tests.mjs
// Focused tests for wallet UX — runnable directly with:
//
//     node scripts/wallet-ux-tests.mjs
//
// (it self-boots the repo's tsx TS loader so it can import the REAL .ts source
// modules, exactly like the other TS-backed scripts). Can also be run as
// `npx tsx scripts/wallet-ux-tests.mjs`.
//
// These tests import the REAL production modules — no inline copies of
// friendlyConnectorLabel / mapWalletError / dedupeConnectors / ensureArcNetwork.
// No network, no DB; ensureArcNetwork is driven with mocked wagmi callbacks and
// mock window.ethereum providers so we can prove which provider gets the add.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Plain `node scripts/wallet-ux-tests.mjs` cannot import .ts source modules.
// Re-spawn through the repo's existing TS execution mechanism (tsx loader) so
// the assertions run against the REAL implementation. Guarded by an env flag.
if (!process.env.WALLET_UX_TESTS_TSX) {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, WALLET_UX_TESTS_TSX: '1' } }
  );
  process.exit(res.status ?? 1);
}

// Real production modules (loaded by the TS runner — this file MUST NOT
// re-implement their logic; the only logic here is mocks + assertions).
let friendlyConnectorLabel, dedupeConnectors, withTimeout, mapWalletError, PUBLIC_CLIENT_CONFIG_VARS;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Silence mapWalletError's per-call console.error for clean output
const origConsoleError = console.error;
console.error = () => {};
try {
  const walletLabels = await import('../src/lib/wallet/walletLabels.ts');
  friendlyConnectorLabel = walletLabels.friendlyConnectorLabel;
  dedupeConnectors = walletLabels.dedupeConnectors;
  withTimeout = walletLabels.withTimeout;
  mapWalletError = (await import('../src/lib/wallet/walletErrors.ts')).mapWalletError;
  PUBLIC_CLIENT_CONFIG_VARS = (await import('../src/lib/env/walletEnvCheck.ts')).PUBLIC_CLIENT_CONFIG_VARS;

// --- Connector presentation: REAL friendlyConnectorLabel ---
// Real announced wallet names must be shown as-is — NOT collapsed into
// "Browser Wallet" (the old known-wallet allowlist did that).
ok('desktop injected MetaMask -> MetaMask', friendlyConnectorLabel({ type: 'injected', name: 'MetaMask' }) === 'MetaMask');
ok('desktop Rabby -> Rabby', friendlyConnectorLabel({ type: 'injected', name: 'Rabby' }) === 'Rabby');
ok('OKX -> OKX', friendlyConnectorLabel({ type: 'injected', name: 'OKX' }) === 'OKX');
ok('Zerion -> Zerion', friendlyConnectorLabel({ type: 'injected', name: 'Zerion' }) === 'Zerion');
ok('Bitget -> Bitget', friendlyConnectorLabel({ type: 'injected', name: 'Bitget Wallet' }) === 'Bitget Wallet');
ok('Ledger -> Ledger', friendlyConnectorLabel({ type: 'injected', name: 'Ledger' }) === 'Ledger');
ok('Taho -> Taho', friendlyConnectorLabel({ type: 'injected', name: 'Taho' }) === 'Taho');
ok('Enkrypt -> Enkrypt', friendlyConnectorLabel({ type: 'injected', name: 'Enkrypt' }) === 'Enkrypt');
ok('Phantom -> Phantom', friendlyConnectorLabel({ type: 'injected', name: 'Phantom' }) === 'Phantom');
// Only generic/internal names fall back
ok('generic Injected -> Browser Wallet', friendlyConnectorLabel({ type: 'injected', name: 'Injected' }) === 'Browser Wallet');
ok('generic Browser Wallet -> Browser Wallet', friendlyConnectorLabel({ type: 'injected', name: 'Browser Wallet' }) === 'Browser Wallet');
ok('name identical to type -> Browser Wallet', friendlyConnectorLabel({ type: 'injected', name: 'injected' }) === 'Browser Wallet');
ok('no name injected -> Browser Wallet', friendlyConnectorLabel({ type: 'injected', name: '' }) === 'Browser Wallet');
ok('WalletConnect type -> WalletConnect', friendlyConnectorLabel({ type: 'walletConnect', name: 'WalletConnect' }) === 'WalletConnect');
ok('walletConnect lower -> WalletConnect', friendlyConnectorLabel({ type: 'walletConnect', name: 'walletconnect' }) === 'WalletConnect');
ok('multiple EIP-6963 wallets distinguishable', (() => {
  const a = friendlyConnectorLabel({ type: 'injected', name: 'MetaMask' });
  const b = friendlyConnectorLabel({ type: 'injected', name: 'Rabby' });
  return a !== b && a === 'MetaMask' && b === 'Rabby';
})());
ok('announced name wins over id; id never invented', friendlyConnectorLabel({ type: 'injected', id: 'com.okex.wallet', name: 'OKX' }) === 'OKX');

// --- dedupeConnectors contract: REAL module, stable identity NOT display name ---
ok('dedupe keeps same-uid connector once', (() => {
  const out = dedupeConnectors([
    { uid: 'a', type: 'injected', name: 'MetaMask' },
    { uid: 'a', type: 'injected', name: 'MetaMask' },
  ]);
  return out.length === 1;
})());
ok('dedupe keeps TWO distinct MetaMask providers (stable identity, not name)', (() => {
  const out = dedupeConnectors([
    { uid: 'a', type: 'injected', name: 'MetaMask' },
    { uid: 'b', type: 'injected', name: 'MetaMask' },
  ]);
  return out.length === 2; // same display name, different stable identity — never hidden
})());
ok('dedupe keeps injected + walletConnect entries separate', (() => {
  const out = dedupeConnectors([
    { uid: 'inj', type: 'injected', name: 'MetaMask' },
    { uid: 'wc', type: 'walletConnect', name: 'WalletConnect' },
  ]);
  return out.length === 2;
})());
ok('dedupe dedups by uid even when names differ', (() => {
  const out = dedupeConnectors([
    { uid: 'x', type: 'injected', name: 'MetaMask' },
    { uid: 'x', type: 'injected', name: 'Rabby' },
  ]);
  return out.length === 1;
})());
ok('dedupe keys by id+type+name when uid missing', (() => {
  const out = dedupeConnectors([
    { type: 'injected', name: 'MetaMask' },
    { type: 'injected', name: 'MetaMask' },
    { type: 'injected', name: 'Rabby' },
  ]);
  return out.length === 2;
})());

// --- Error mapping: REAL mapWalletError ---
  ok('viem User rejected does not leak', mapWalletError('User rejected the request. Details: Connection request reset. Please try again. Version: viem@2.55.11').message === 'Connection cancelled. No changes were made.');
  ok('Connection request reset -> cannot-open-wallet-app copy', mapWalletError('Connection request reset. Please try again. Version: viem@2.55.11').message === "We couldn't open your wallet app. Try again, or copy this link and open it in your wallet app.");
  ok('Provider not found -> wallet not found', mapWalletError('Provider not found. Version: @wagmi/core@x').message.includes("couldn't find a wallet"));
  ok('timeout did not respond -> actionable', mapWalletError("Timed out waiting for your wallet to respond. Check your wallet app/extension and try again.").message.includes("didn't respond"));
  ok('raw viem version never shown', (() => {
    const msg = mapWalletError('Error: something Version: viem@2.55.11 and Version: @wagmi/core@2.1').message;
    return !msg.toLowerCase().includes('viem') && !msg.toLowerCase().includes('wagmi');
  })());
  ok('generic failure is friendly', mapWalletError('Some unknown blockchain error 0x123').message === "We couldn't connect your wallet. Please try again.");
  ok('error kinds are typed', mapWalletError('user denied').kind === 'USER_REJECTED' && mapWalletError('qr code expired').kind === 'WC_TIMEOUT');

  // --- Funds / gas-allowance errors: shared mapper centralizes them ---
  const FUNDS_COPY = "This payment can't be completed with the funds currently in this wallet. Top up (or check the token allowance) and try again.";
  // viem custom-error shape: ContractFunctionExecutionError carries a
  // shortMessage that embeds the solidity custom error name (e.g. OutOfFunds).
  {
    const viemErr = Object.assign(
      new Error('Execution reverted with the following reason: OutOfFunds()'),
      { shortMessage: 'The contract function "transfer" reverted. Error: OutOfFunds()' }
    );
    const mapped = mapWalletError(viemErr);
    ok('viem OutOfFunds custom error -> INSUFFICIENT_FUNDS', mapped.kind === 'INSUFFICIENT_FUNDS', `got ${mapped.kind}`);
    ok('viem OutOfFunds -> friendly funds copy', mapped.message === FUNDS_COPY, `got "${mapped.message}"`);
    ok('viem OutOfFunds copy does not leak internals', !/viem|wagmi|contract function/i.test(mapped.message));
    ok('viem OutOfFunds copy does NOT claim "no changes were made"', !mapped.message.toLowerCase().includes('no changes were made'));
  }
  {
    const mapped = mapWalletError('ERC-20 transfer reverted: out of funds');
    ok("'out of funds' string -> INSUFFICIENT_FUNDS", mapped.kind === 'INSUFFICIENT_FUNDS' && mapped.message === FUNDS_COPY, `got ${mapped.kind}`);
  }
  {
    const mapped = mapWalletError('Gas required exceeds allowance or always failing transaction.');
    ok("'gas required exceeds allowance' -> INSUFFICIENT_FUNDS (not shadowed by timeout/rejected branches)", mapped.kind === 'INSUFFICIENT_FUNDS' && mapped.message === FUNDS_COPY, `got ${mapped.kind}`);
  }
  {
    const mapped = mapWalletError('Some unknown blockchain error 0x456');
    ok('unrelated error still maps to GENERIC (no funds false-positive regression)', mapped.kind === 'GENERIC');
  }

  // --- withTimeout: REAL module ---
  await withTimeout(Promise.resolve('fast'), 1000).then((v) => ok('withTimeout passes through fast promise', v === 'fast'));
  await withTimeout(new Promise((resolve) => setTimeout(() => resolve('slow'), 200)), 10, 'Timed out').then(
    () => ok('withTimeout rejects on deadline', false, 'resolved instead of rejecting'),
    (err) => ok('withTimeout rejects on deadline', String(err.message) === 'Timed out')
  );

  // --- Network switching: REAL ensureArcNetwork with mock providers ---
  const { ensureArcNetwork } = await import('../src/lib/wallet/ensureArcNetwork.ts');
  const { arcTestnet } = await import('../src/lib/wagmi.ts');
  const ARC = arcTestnet.id;

  function makeProvider(label) {
    const calls = [];
    return {
      calls,
      provider: {
        request: async ({ method, params }) => {
          calls.push({ from: label, method, params });
          return null;
        },
      },
    };
  }

  // already on Arc -> no action
  {
    let switchCalled = false;
    const res = await ensureArcNetwork({ chainId: ARC, switchChainAsync: async () => { switchCalled = true; } });
    ok('already on Arc -> ok, no switch call', res.ok === true && switchCalled === false);
  }

  // known chain -> plain switch works
  {
    let switchedTo = null;
    const res = await ensureArcNetwork({ chainId: 1, switchChainAsync: async ({ chainId }) => { switchedTo = chainId; } });
    ok('known chain -> switch to Arc', res.ok === true && switchedTo === ARC);
  }

  // unknown chain -> add through the ACTIVE CONNECTOR's provider (not window.ethereum)
  {
    const active = makeProvider('activeConnector');
    const fallback = makeProvider('window.ethereum');
    globalThis.window = { ethereum: fallback.provider };
    try {
      const res = await ensureArcNetwork({
        chainId: 1,
        switchChainAsync: async () => { throw Object.assign(new Error('Unrecognized chain.'), { code: 4902 }); },
        getProvider: async () => active.provider,
      });
      const addOnActive = active.calls.some((c) => c.method === 'wallet_addEthereumChain');
      const addOnFallback = fallback.calls.some((c) => c.method === 'wallet_addEthereumChain');
      ok('unknown chain -> add+switch ok', res.ok === true);
      ok('add went through the ACTIVE connector provider, never window.ethereum', addOnActive && !addOnFallback, JSON.stringify({ active: active.calls, fallback: fallback.calls }));
      ok('add params carry Arc chainId + rpc + native currency + explorer', (() => {
        const p = active.calls.find((c) => c.method === 'wallet_addEthereumChain')?.params?.[0];
        return p && Number(p.chainId) === ARC && Array.isArray(p.rpcUrls) && p.rpcUrls.length > 0 && p.nativeCurrency?.symbol === 'ARC' && Array.isArray(p.blockExplorerUrls);
      })());
    } finally {
      delete globalThis.window;
    }
  }

  // getProvider throws -> falls back to window.ethereum
  {
    const fallback = makeProvider('window.ethereum');
    globalThis.window = { ethereum: fallback.provider };
    try {
      const res = await ensureArcNetwork({
        chainId: 1,
        switchChainAsync: async () => { throw Object.assign(new Error('Unrecognized chain.'), { code: 4902 }); },
        getProvider: async () => { throw new Error('connector unavailable'); },
      });
      ok('getProvider failure -> falls back to window.ethereum and succeeds', res.ok === true && fallback.calls.some((c) => c.method === 'wallet_addEthereumChain'));
    } finally {
      delete globalThis.window;
    }
  }

  // user rejects the ADD -> friendly cancellation
  {
    const res = await ensureArcNetwork({
      chainId: 1,
      switchChainAsync: async () => { throw Object.assign(new Error('Unrecognized chain.'), { code: 4902 }); },
      getProvider: async () => ({ request: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } }),
    });
    ok('user rejects add -> REJECTED with friendly copy', res.ok === false && res.reason === 'REJECTED' && res.message.toLowerCase().includes('cancelled'));
  }

  // user rejects the plain SWITCH -> friendly cancellation
  {
    const res = await ensureArcNetwork({
      chainId: 1,
      switchChainAsync: async () => { throw new Error('User rejected the request.'); },
    });
    ok('user rejects switch -> REJECTED', res.ok === false && res.reason === 'REJECTED');
  }

  // wallet cannot add -> clear manual instructions
  {
    const res = await ensureArcNetwork({
      chainId: 1,
      switchChainAsync: async () => { throw Object.assign(new Error('Unrecognized chain.'), { code: 4902 }); },
      getProvider: async () => ({ request: async () => { throw new Error('This wallet does not support adding custom networks'); } }),
    });
    ok('wallet cannot add -> UNSUPPORTED + clear manual instructions', res.ok === false && res.reason === 'UNSUPPORTED' && res.message.includes('Arc Testnet') && res.message.toLowerCase().includes('open your wallet'));
  }

  // timeout while switching
  {
    const res = await ensureArcNetwork({
      chainId: 1,
      switchChainAsync: async () => { throw new Error('Connection timeout while switching chain'); },
    });
    ok('switch timeout -> TIMEOUT', res.ok === false && res.reason === 'TIMEOUT');
  }

  // --- WalletConnect env configuration: explicit, documented, not hardcoded ---
  ok('WC project ID is a documented public client config var', PUBLIC_CLIENT_CONFIG_VARS.some((v) => v.keyVar === 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID'));
  {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    const src = readFileSync(new URL('../src/lib/wagmi.ts', `file://${here.replaceAll('\\', '/')}`), 'utf8');
    ok('wagmi.ts does NOT hardcode a WalletConnect project ID', !/['"][0-9a-fA-F]{32,}['"]/.test(src));
    ok('wagmi.ts registers walletConnect ONLY when the project ID is set', src.includes('isBrowser && walletConnectProjectId'));
    ok('wagmi.ts metadata keeps window.location.origin behavior', src.includes('window.location.origin'));
    ok('wagmi.ts warns explicitly when the project ID is missing', src.includes('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set'));
  }
} finally {
  console.error = origConsoleError;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
