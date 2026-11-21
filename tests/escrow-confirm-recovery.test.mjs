// Execute the actual page callbacks with in-memory wallet/RPC/HTTP mocks.
// No database, network, credentials, or real transaction submission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { isAddress, parseAbi, decodeAbiParameters, keccak256, toBytes } from 'viem';
import { Interface } from 'ethers';

const source = readFileSync(new URL('../src/app/escrow-confirm/[reference]/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('confirm.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let stateAbi;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useCallback') {
      callbacks.set(node.name.text, node.initializer.arguments[0].getText(ast));
    }
    if (node.name.text === 'escrowStateAbi') stateAbi = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function callback(name, dependencies) {
  assert.ok(callbacks.has(name), `Missing actual callback: ${name}`);
  const js = ts.transpileModule(`return (${callbacks.get(name)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), js)(...Object.values(dependencies));
}

const beneficiary = `0x${'ab'.repeat(20)}`, contract = `0x${'cd'.repeat(20)}`;
const originalHash = `0x${'11'.repeat(32)}`, replacementHash = `0x${'22'.repeat(32)}`;
const escrowId = `0x${'33'.repeat(32)}`;
const abi = new Function('parseAbi', `return ${stateAbi};`)(parseAbi);
class ConfirmationError extends Error {}

function setup(options = {}) {
  const broadcasts = [], reads = [], requests = [], receipts = [], events = [], providerChecks = [], storage = new Map();
  const running = { current: false }, submitted = { current: options.savedHash ? { reference: options.savedReference || 'qa-confirm', hash: options.savedHash } : null };
  let details = { reference: 'qa-confirm', status: 'ACTIVE', funded: true, contractAddress: contract, contractEscrowId: escrowId, beneficiarySCA: beneficiary, beneficiaryConfirmed: false, depositorConfirmed: false, ...options.details };
  const ui = { step: 'connect', status: '', txHash: null, explorerUrl: null };
  let waits = 0, posts = 0, chainReads = 0;
  const connector = { getProvider: async () => ({ request: async () => '0x13b2' }) };
  const setDetails = (update) => { details = update(details); };
  const setTxHash = (hash) => { ui.txHash = hash; };
  const setExplorerUrl = (url) => { ui.explorerUrl = url; };
  const explorerTx = (hash) => `https://explorer.example.test/tx/${hash}`;
  const rememberConfirmation = callback('rememberConfirmation', {
    submitted, reference: 'qa-confirm', setTxHash, setExplorerUrl, explorerTx,
    storageKey: 'qa-scoped-storage-key', sessionStorage: { setItem: (key, value) => { if (options.storageBlocked) throw new Error('Storage disabled'); storage.set(key, value); } },
  });
  const deps = {
    running, submitted, reference: 'qa-confirm', details, address: options.disconnected ? undefined : options.wrongWallet ? contract : beneficiary,
    isBeneficiary: !options.wrongWallet && !options.disconnected,
    setStep: (step) => { ui.step = step; events.push(`step:${step}`); }, setStatusText: (status) => { ui.status = status; },
    setDetails, setExplorerUrl, setTxHash, rememberConfirmation, isAddress, escrowStateAbi: abi, ConfirmationError,
    activeChainId: 5042, activeChain: { id: 5042 }, chainId: 5042, connector,
    switchChainAsync: async () => {},
    ensureArcNetwork: async (args) => {
      providerChecks.push(await args.getProvider());
      return options.networkRejected ? { ok: false, message: 'Network rejected' } : { ok: true };
    },
    confirmDeliveryAbi: [{ type: 'function', name: 'confirmDelivery', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32', name: 'escrowId' }], outputs: [] }],
    publicClient: options.noClient ? undefined : {
      getChainId: async () => { chainReads++; events.push('chain'); return options.wrongRpc || (options.chainChanges && chainReads === 2) ? 5042002 : 5042; },
      getBlock: async () => { events.push('block'); if (options.rpcFailure) throw new Error('RPC unavailable'); return { number: 123n, timestamp: 1000n }; },
      readContract: async (args) => {
        reads.push(args);
        if (args.functionName === 'settled') return !!options.settled;
        if (args.functionName === 'disputed') return !!options.disputed;
        return { beneficiary: options.foreignBeneficiary ? contract : beneficiary, deadline: options.expired ? 1000n : 2000n, beneficiaryConfirmed: !!options.alreadyConfirmed, depositorConfirmed: !!options.depositorConfirmed };
      },
      waitForTransactionReceipt: async (args) => {
        waits++; receipts.push(args.hash); events.push('receipt');
        if (options.waitTimeout && waits === 1) throw new Error('Receipt timeout');
        if (options.replacementReason) args.onReplaced({ reason: options.replacementReason, transactionReceipt: { transactionHash: replacementHash } });
        return { status: options.reverted ? 'reverted' : 'success', transactionHash: options.replacementReason ? replacementHash : args.hash };
      },
    },
    writeContractAsync: async (tx) => { broadcasts.push(tx); events.push('broadcast'); if (options.walletRejected) throw new Error('Wallet rejected'); return originalHash; },
    fetch: async (url, init) => {
      posts++; requests.push({ url, init }); events.push('post');
      if (options.postTimeout && posts === 1) throw new Error('Recording timeout');
      if (options.invalidJson && posts === 1) return { ok: true, json: async () => { throw new Error('Invalid JSON'); } };
      const ok = !(options.verifyRetry && posts === 1);
      return { ok, json: async () => ({ success: ok, error: 'Verification unavailable', released: !!options.released, depositorConfirmed: !!options.released }) };
    },
    explorerTx, friendlyWalletError: (error) => error.message,
  };
  const run = callback('confirmDelivery', deps);
  const retry = callback('retryConfirmation', { submitted, reference: 'qa-confirm', confirmDelivery: run, setStep: deps.setStep, setStatusText: deps.setStatusText });
  return { run, retry, broadcasts, reads, requests, receipts, events, providerChecks, submitted, running, storage, ui, details: () => details };
}

test('preflight verifies the RPC chain twice before fixed-block state reads and selected-connector signing', async () => {
  const s = setup(); await s.run();
  assert.deepEqual(s.events.slice(0, 4), ['step:confirm', 'chain', 'chain', 'block']);
  assert.equal(s.reads.length, 3); assert.ok(s.reads.every((read) => read.blockNumber === 123n));
  assert.equal(s.providerChecks.length, 1); assert.equal(s.broadcasts.length, 1);
  assert.equal(s.broadcasts[0].account, beneficiary); assert.equal(s.broadcasts[0].chainId, 5042);
  assert.ok(s.broadcasts[0].connector); assert.equal(s.broadcasts[0].functionName, 'confirmDelivery');
  assert.ok(s.events.indexOf('post') > s.events.indexOf('receipt')); assert.equal(s.ui.step, 'done');
});
test('duplicate clicks synchronously lock before the first asynchronous operation', async () => {
  const s = setup(); await Promise.all([s.run(), s.run(), s.run()]);
  assert.equal(s.broadcasts.length, 1); assert.equal(s.requests.length, 1); assert.equal(s.running.current, false);
});
for (const [name, option] of Object.entries({ 'receipt timeout': 'waitTimeout', 'API rejection': 'verifyRetry', 'API timeout': 'postTimeout', 'invalid API JSON': 'invalidJson' })) {
  test(`${name} retains the hash and retry never signs or pays again`, async () => {
    const s = setup({ [option]: true }); await s.run();
    assert.equal(s.ui.step, 'error'); assert.equal(s.submitted.current.hash, originalHash);
    assert.equal(s.storage.get('qa-scoped-storage-key'), originalHash); assert.match(s.ui.status, /without signing or paying again/);
    await s.run(); assert.equal(s.broadcasts.length, 1); assert.equal(s.ui.step, 'done');
    assert.ok(s.receipts.every((hash) => hash === originalHash)); assert.equal(s.running.current, false);
  });
}
test('Try again without a submitted hash restores the actionable connect step, not the frozen confirm step', () => {
  const s = setup(); s.ui.step = 'error'; s.retry();
  assert.equal(s.ui.step, 'connect'); assert.equal(s.ui.status, ''); assert.equal(s.broadcasts.length, 0);
});
test('retry with a saved hash runs verification rather than resetting or rebroadcasting', async () => {
  const s = setup({ savedHash: originalHash }); s.retry();
  // Await the already-started callback through its mocked verification completion.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.ui.step, 'done'); assert.equal(s.broadcasts.length, 0); assert.equal(s.requests.length, 1);
});
test('existing-hash recovery is public and never connects, switches networks, or signs', async () => {
  const s = setup({ disconnected: true }); await s.run(originalHash);
  assert.equal(s.broadcasts.length, 0); assert.equal(s.providerChecks.length, 0); assert.equal(s.reads.length, 0);
  assert.equal(s.ui.step, 'done'); assert.deepEqual(JSON.parse(s.requests[0].init.body), { callerSCA: beneficiary, txHash: originalHash });
  assert.ok(s.requests[0].init.signal instanceof AbortSignal);
});
test('manual recovery can correct a previously saved hash without triggering a new transaction', async () => {
  const s = setup({ savedHash: originalHash }); await s.run(replacementHash);
  assert.equal(s.receipts[0], replacementHash); assert.equal(s.broadcasts.length, 0);
});
test('malformed or empty manual hashes never fall through to signing', async () => {
  for (const hash of ['', '0x123', `0x${'zz'.repeat(32)}`]) {
    const s = setup(); await s.run(hash); assert.equal(s.broadcasts.length, 0); assert.equal(s.ui.step, 'error');
  }
});
test('saved hashes belonging to a different reference are not reused', async () => {
  const s = setup({ savedHash: replacementHash, savedReference: 'different-reference' }); await s.run();
  assert.equal(s.broadcasts.length, 1); assert.equal(s.receipts[0], originalHash);
});
test('already-confirmed chain state overrides stale false mirror flags without a wallet request', async () => {
  const s = setup({ alreadyConfirmed: true }); await s.run();
  assert.equal(s.broadcasts.length, 0); assert.equal(s.providerChecks.length, 0); assert.equal(s.ui.step, 'done');
  assert.equal(s.details().beneficiaryConfirmed, true); assert.match(s.ui.status, /already on-chain/);
});
test('already-released on-chain state is displayed as released, without another confirmation', async () => {
  const s = setup({ alreadyConfirmed: true, depositorConfirmed: true, settled: true }); await s.run();
  assert.equal(s.details().status, 'RELEASED'); assert.equal(s.broadcasts.length, 0);
});
test('an existing confirmation after expiry or dispute does not falsely promise a pending release', async () => {
  for (const option of [{ expired: true }, { disputed: true }]) {
    const s = setup({ alreadyConfirmed: true, ...option }); await s.run();
    assert.equal(s.broadcasts.length, 0); assert.equal(s.ui.step, 'done'); assert.doesNotMatch(s.ui.status, /Waiting for the depositor/);
  }
});
for (const option of ['wrongWallet', 'disconnected', 'wrongRpc', 'chainChanges', 'rpcFailure', 'foreignBeneficiary', 'settled', 'disputed', 'expired', 'networkRejected', 'noClient']) {
  test(`${option} blocks signing and recording`, async () => {
    const s = setup({ [option]: true }); await s.run();
    assert.equal(s.broadcasts.length, 0); assert.equal(s.requests.length, 0); assert.equal(s.ui.step, 'error'); assert.equal(s.running.current, false);
  });
}
test('non-active, unfunded, wrong-reference, or malformed contract details fail closed', async () => {
  for (const details of [{ status: 'REFUNDED' }, { funded: false }, { reference: 'wrong-reference' }, { contractAddress: '0x123' }, { contractEscrowId: '0x123' }]) {
    const s = setup({ details }); await s.run(); assert.equal(s.broadcasts.length, 0); assert.equal(s.requests.length, 0); assert.equal(s.ui.step, 'error');
  }
});
test('wallet rejection releases the synchronous guard and keeps no fake submitted hash', async () => {
  const s = setup({ walletRejected: true }); await s.run();
  assert.equal(s.submitted.current, null); assert.equal(s.running.current, false); assert.equal(s.requests.length, 0);
  s.retry(); assert.equal(s.ui.step, 'connect');
});
test('reverted receipt stays saved and never automatically broadcasts again', async () => {
  const s = setup({ reverted: true }); await s.run(); await s.run();
  assert.equal(s.broadcasts.length, 1); assert.equal(s.requests.length, 0); assert.equal(s.ui.step, 'error');
});
test('repriced confirmation records the actual mined replacement hash', async () => {
  const s = setup({ replacementReason: 'repriced' }); await s.run();
  assert.equal(s.broadcasts.length, 1); assert.equal(JSON.parse(s.requests[0].init.body).txHash, replacementHash);
  assert.equal(s.submitted.current.hash, replacementHash);
});
test('cancelled or replaced transactions do not mark confirmation complete', async () => {
  for (const replacementReason of ['cancelled', 'replaced']) {
    const s = setup({ replacementReason }); await s.run();
    assert.equal(s.requests.length, 0); assert.equal(s.ui.step, 'error'); assert.equal(s.submitted.current.hash, originalHash);
  }
});
test('blocked browser storage does not lose the in-memory recovery hash', async () => {
  const s = setup({ storageBlocked: true, verifyRetry: true }); await s.run(); await s.run();
  assert.equal(s.broadcasts.length, 1); assert.equal(s.ui.step, 'done');
});
test('read-only preflight ABI encodes and decodes the authoritative contract tuple', () => {
  const contractSource = readFileSync(new URL('../contracts/FlareHQEscrow.sol', import.meta.url), 'utf8');
  assert.match(contractSource, /mapping\s*\(bytes32\s*=>\s*bool\)\s*public\s+settled/);
  assert.match(contractSource, /mapping\s*\(bytes32\s*=>\s*bool\)\s*public\s+disputed/);
  const iface = new Interface(abi);
  assert.equal(iface.getFunction('confirmDelivery'), null);
  const encoded = iface.encodeFunctionResult('getEscrow', [[contract, beneficiary, 50000n, 2000n, 'qa-confirm', false, true]]);
  const decoded = iface.decodeFunctionResult('getEscrow', encoded)[0];
  assert.equal(decoded.beneficiary.toLowerCase(), beneficiary); assert.equal(decoded.beneficiaryConfirmed, true);
});
test('UI keeps a full saved hash, scoped refresh recovery, and an explicit progress status', () => {
  assert.match(source, /escrow-confirm:\$\{activeChainId\}:\$\{reference\}:\$\{details\.contractAddress\.toLowerCase\(\)\}/);
  assert.match(source, /sessionStorage\.getItem\(storageKey\)/);
  assert.match(source, /Saved transaction:/); assert.match(source, /role="status" aria-live="polite"/);
  assert.doesNotMatch(source, /Working…/);
  assert.match(source, /<EscrowConfirmation key=\{reference\}/);
});

// The new public recovery form must still pass every existing server proof.
// Compile the actual route with a completely mocked database/chain boundary.
function recordingRoute(options = {}) {
  const updates = [], calls = [];
  const escrow = { reference: 'qa-confirm', status: options.terminal ? 'RELEASED' : 'ACTIVE', beneficiarySCA: beneficiary, depositorSCA: contract, contractEscrowId: escrowId, deadline: new Date(Date.now() + (options.expired ? -60000 : 60000)), amount: 0.05, currency: 'USDC', depositorConfirmed: false, merchantId: null, webhookUrl: null };
  const stubs = {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/prisma': { prisma: { escrow: {
      findUnique: async () => { calls.push('database-read'); return escrow; },
      update: async (query) => { updates.push(query); return { ...escrow, ...query.data }; },
    } } },
    '@/lib/ratelimit': { checkRateLimit: async () => options.limited ? { allowed: false, response: new Response(null, { status: 429 }) } : { allowed: true } },
    'viem': { isAddress, decodeAbiParameters, keccak256, toBytes },
    '@/lib/wallet/flarehqContracts': { escrowAbi: [], escrowSelectors: { confirmDelivery: '0x74950ffd' } },
    '@/lib/wallet/chainClient': {
      getTransactionReliable: async () => {
        calls.push('transaction');
        if (options.missingTx) return null;
        return { from: options.wrongSender ? contract : beneficiary, to: options.wrongTarget ? beneficiary : contract, input: `${options.wrongSelector ? '0xdeadbeef' : '0x74950ffd'}${options.wrongId ? '44'.repeat(32) : escrowId.slice(2)}` };
      },
      getReceiptReliable: async () => { calls.push('receipt'); return options.missingReceipt ? null : { status: options.failedReceipt ? 'reverted' : 'success', blockNumber: 123n }; },
      extractSelector: (input) => input.slice(0, 10),
      readContractReliable: async (query) => {
        calls.push(`state:${query.blockNumber}`);
        return options.missingState ? null : { beneficiaryConfirmed: !options.unconfirmed, depositorConfirmed: false, amount: 50000n };
      },
    },
    '@/lib/notifications': { notify: async () => {} },
    '@/lib/config/network': { explorerTxUrl: (hash) => `https://explorer.example.test/tx/${hash}` },
    '@/lib/escrow/escrowGuard': { escrowAddressOr503: () => options.unavailable ? { response: new Response(null, { status: 503 }) } : { address: contract } },
  };
  const module = { exports: {} };
  const route = readFileSync(new URL('../src/app/api/escrow/[reference]/beneficiary-confirm/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(route, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', 'console', code)((name) => {
    if (!Object.hasOwn(stubs, name)) throw new Error('Unexpected recording dependency');
    return stubs[name];
  }, module, module.exports, { error: () => {} });
  return {
    updates, calls,
    run: (body = { callerSCA: beneficiary, txHash: originalHash }) => module.exports.POST(new Request('https://example.test/api/escrow/qa-confirm/beneficiary-confirm', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ reference: 'qa-confirm' }) }),
  };
}
test('public recovery records only a successful exact beneficiary confirmation and fixed-block chain proof', async () => {
  const s = recordingRoute(); const response = await s.run(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.success, true); assert.equal(body.released, false);
  assert.equal(s.updates.length, 1); assert.equal(s.updates[0].data.beneficiaryConfirmed, true);
  assert.equal(s.updates[0].data.status, 'ACTIVE'); assert.ok(s.calls.includes('state:123'));
});
for (const option of ['wrongSender', 'wrongTarget', 'wrongSelector', 'wrongId', 'missingTx', 'missingReceipt', 'failedReceipt', 'missingState', 'unconfirmed']) {
  test(`public recovery rejects ${option} without a database mutation`, async () => {
    const s = recordingRoute({ [option]: true }); const response = await s.run();
    assert.ok(response.status >= 400); assert.equal(s.updates.length, 0);
  });
}
test('public recovery retains request validation, network availability, rate limits, and terminal/expiry guards', async () => {
  for (const option of [{ unavailable: true }, { limited: true }, { terminal: true }, { expired: true }]) {
    const s = recordingRoute(option); assert.ok((await s.run()).status >= 400);
    assert.equal(s.updates.length, 0); assert.ok(!s.calls.includes('transaction'));
  }
  for (const body of [{ callerSCA: contract, txHash: originalHash }, { callerSCA: beneficiary, txHash: '0x123' }]) {
    const s = recordingRoute(); assert.ok((await s.run(body)).status >= 400); assert.equal(s.updates.length, 0);
  }
});
