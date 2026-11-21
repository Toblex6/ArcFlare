// Actual wallet handler, pure in-memory mocked signing/receipts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/jobs/FlareHQExternalTransactions.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('external.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'run') handler = node; ts.forEachChild(node, visit); }
visit(ast);
assert.ok(handler);
const code = ts.transpileModule(`${handler.getText(ast)}; return run;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const client = `0x${'ab'.repeat(20)}`, target = `0x${'cd'.repeat(20)}`;

function setup(options = {}) {
  const broadcasts = [], receipts = [], requests = [], errors = [], prompts = [];
  const running = { current: false }, submitted = { current: [] }, completed = { current: 0 };
  let done = 0, waits = 0, verifies = 0;
  const transactions = [0, 1].map((i) => ({ chainId: 5042, from: client, to: target, abiFunctionSignature: i ? 'createEscrow(bytes32)' : 'approve(address,uint256)', args: [], value: '0' }));
  if (options.foreignChain) transactions[0].chainId = 5042002;
  const deps = {
    running, address: options.foreignSigner ? target : client, setError: (e) => errors.push(e), setBusy: () => {},
    publicClient: { waitForTransactionReceipt: async ({ hash }) => {
      receipts.push(hash); waits++;
      if (options.waitTimeout && waits === 1) throw new Error('Receipt timeout');
      return { status: options.reverted ? 'reverted' : 'success' };
    } }, transactions, chain: { id: 5042 }, connector: { getProvider: async () => ({}) },
    chainId: 5042, switchChainAsync: async () => {}, ensureArcNetwork: async () => ({ ok: true }),
    completed, submitted, parseAbiItem: () => ({}), setStep: () => {},
    writeContractAsync: async (tx) => { broadcasts.push(tx); return `0x${String(broadcasts.length).padStart(64, '0')}`; },
    consumerAddress: options.consumer ? client : undefined,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url === '/api/consumer/security') return { ok: true, json: async () => ({ success: true, walletAddress: options.securityMismatch ? target : client, hasPin: true }) };
      verifies++;
      return { ok: !(options.verifyRetry && verifies === 1), json: async () => ({ success: !(options.verifyRetry && verifies === 1), error: 'Verification unavailable' }) };
    },
    requestPin: async (options_) => { prompts.push(options_); return options.cancel ? null : 'synthetic-proof'; },
    confirm: { endpoint: '/api/flarehq-jobs/job-a/approve', body: { context: 'job-a' } },
    onDone: async () => { done++; }, friendlyWalletError: () => '',
  };
  return { run: new Function(...Object.keys(deps), code)(...Object.values(deps)), broadcasts, receipts, requests, errors, prompts, completed, running, done: () => done };
}

test('approval and funding each wait for a successful receipt before final verification', async () => {
  const s = setup(); await s.run();
  assert.equal(s.broadcasts.length, 2); assert.equal(s.receipts.length, 2); assert.equal(s.completed.current, 2);
  const proof = JSON.parse(s.requests[0].init.body);
  assert.ok(proof.txHash === s.receipts[1]); assert.equal(s.done(), 1);
});
test('receipt timeout retry reuses submitted hash instead of broadcasting twice', async () => {
  const s = setup({ waitTimeout: true }); await s.run();
  assert.equal(s.broadcasts.length, 1); assert.equal(s.completed.current, 0);
  await s.run(); assert.equal(s.broadcasts.length, 2); assert.equal(s.receipts.length, 3);
  assert.ok(s.receipts[0] === s.receipts[1]); assert.equal(s.done(), 1);
});
test('verification failure retry preserves the final hash and sends no further transaction', async () => {
  const s = setup({ verifyRetry: true }); await s.run(); await s.run();
  assert.equal(s.broadcasts.length, 2); assert.equal(s.requests.length, 2); assert.equal(s.done(), 1);
  assert.ok(JSON.parse(s.requests[0].init.body).txHash === JSON.parse(s.requests[1].init.body).txHash);
});
test('reverted receipt stops dependent funding and never silently rebroadcasts', async () => {
  const s = setup({ reverted: true }); await s.run(); await s.run();
  assert.equal(s.broadcasts.length, 1); assert.equal(s.requests.length, 0); assert.equal(s.done(), 0);
});
test('foreign chain or signer fails before any broadcast', async () => {
  for (const option of [{ foreignChain: true }, { foreignSigner: true }]) {
    const s = setup(option); await s.run(); assert.equal(s.broadcasts.length, 0); assert.equal(s.requests.length, 0);
  }
});
test('duplicate click submits one sequence only', async () => {
  const s = setup(); const first = s.run(); await s.run(); await first;
  assert.equal(s.broadcasts.length, 2); assert.equal(s.done(), 1); assert.equal(s.running.current, false);
});
test('consumer confirmation uses masked step-up proof only in its header', async () => {
  const s = setup({ consumer: true }); await s.run();
  assert.equal(s.prompts.length, 1); assert.equal(s.requests.length, 2);
  assert.ok(s.requests[1].init.headers['x-consumer-pin'] === 'synthetic-proof');
  assert.ok(!s.requests[1].init.body.includes('synthetic-proof')); assert.equal(s.done(), 1);
});
test('canceled PIN or changed session retains receipts without sending confirmation', async () => {
  for (const option of [{ cancel: true }, { securityMismatch: true }]) {
    const s = setup({ consumer: true, ...option }); await s.run(); await s.run();
    assert.equal(s.broadcasts.length, 2); assert.equal(s.requests.filter((r) => r.init?.method === 'POST').length, 0);
    assert.equal(s.done(), 0);
  }
});
