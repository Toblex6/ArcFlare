// Run: npx tsx --test tests/floating-assistant-step-up.test.mjs
// Exercises the widget's actual confirmation handler with injected UI/network
// dependencies. No session, database, RPC, PIN prompt or funds are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { requestNeedsStepUp } from '../src/lib/payments/requestStepUp.ts';

const source = readFileSync(new URL('../src/components/FlowAssistantWidget.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('FlowAssistantWidget.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleConfirm') handler = node.initializer;
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler && ts.isArrowFunction(handler));
const compiled = ts.transpileModule(`return (${handler.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const makeHandler = new Function('confirmingRef', 'setSending', 'hasPin', 'ownWallet', 'requestNeedsStepUp', 'fetch', 'setHasPin', 'requestPin', 'addMessage', compiled);
const own = `0x${'ab'.repeat(20)}`;
const other = `0x${'cd'.repeat(20)}`;
// Synthetic test-only credential; never comes from a real account or env.
const syntheticCredential = 'mock-step-up-proof';
const action = (kind = 'request', recipient = other) => ({ action: kind, amount: 0.01, currency: 'USDC', recipientAddress: recipient });

function setup(options = {}) {
    const calls = [];
    const prompts = [];
    const messages = [];
    const sending = [];
    const enrollmentUpdates = [];
    const lock = { current: false };
    const fetch = async (url, init) => {
        calls.push({ url, init });
        if (options.fetch) return options.fetch(url, init);
        if (url === '/api/consumer/security') return { ok: true, json: async () => ({ success: true, hasPin: true }) };
        return { ok: true, json: async () => ({ success: true, reply: 'Done' }) };
    };
    const requestPin = async (prompt) => {
        prompts.push(prompt);
        return options.requestPin ? options.requestPin(prompt) : syntheticCredential;
    };
    const confirm = makeHandler(lock, (v) => sending.push(v), options.hasPin === undefined ? true : options.hasPin,
        options.ownWallet === undefined ? own : options.ownWallet, requestNeedsStepUp, fetch,
        (v) => enrollmentUpdates.push(v), requestPin, (m) => messages.push(m));
    return { confirm, calls, prompts, messages, sending, enrollmentUpdates, lock };
}

test('widget renders the shared masked PIN dialog and uses the shared request policy', () => {
    assert.match(source, /import \{ useSecurePinDialog \} from '@\/components\/SecurePinDialog'/);
    assert.match(source, /import \{ requestNeedsStepUp \} from '@\/lib\/payments\/requestStepUp'/);
    assert.match(source, /\{pinDialog\}/);
    assert.match(source, /data\.account\?\.walletAddress/);
    assert.doesNotMatch(handler.getText(ast), /localStorage|sessionStorage|console\.|window\.prompt/);
});

for (const recipient of [undefined, null, '', own, own.toUpperCase()]) {
    test(`own-wallet request skips PIN and security reads (${String(recipient)})`, async () => {
        const s = setup({ hasPin: null });
        const request = { action: 'request', amount: 0.01, recipientAddress: recipient };
        await s.confirm(request);
        assert.equal(s.prompts.length, 0);
        assert.equal(s.calls.length, 1);
        assert.equal(s.calls[0].url, '/api/consumer/assistant');
        assert.equal(s.calls[0].init.headers['x-consumer-pin'], undefined);
    });
}

for (const kind of ['request', 'send', 'save']) {
    test(`${kind} protected confirmation prompts and forwards proof only in the header`, async () => {
        const s = setup();
        const confirmed = action(kind);
        await s.confirm(confirmed);
        assert.equal(s.prompts.length, 1);
        assert.equal(s.prompts[0].title, 'Authorize this action');
        assert.equal(s.calls.length, 1);
        assert.equal(s.calls[0].init.headers['x-consumer-pin'], syntheticCredential);
        assert.deepEqual(JSON.parse(s.calls[0].init.body), { confirmedAction: confirmed });
        assert.ok(!s.calls[0].url.includes(syntheticCredential));
        assert.ok(!s.calls[0].init.body.includes(syntheticCredential));
        assert.ok(!JSON.stringify(s.messages).includes(syntheticCredential));
        assert.equal(s.lock.current, false);
        assert.deepEqual(s.sending, [true, false]);
    });
}

test('cancelling the PIN submits nothing and releases the confirmation lock', async () => {
    const s = setup({ requestPin: async () => null });
    await s.confirm(action('send'));
    assert.equal(s.calls.length, 0);
    assert.equal(s.messages.length, 0);
    assert.equal(s.lock.current, false);
    assert.deepEqual(s.sending, [true, false]);
});

test('unknown enrollment is read before prompting, never treated as no PIN', async () => {
    const s = setup({ hasPin: null });
    await s.confirm(action());
    assert.deepEqual(s.calls.map((c) => c.url), ['/api/consumer/security', '/api/consumer/assistant']);
    assert.equal(s.calls[0].init.cache, 'no-store');
    assert.equal(s.prompts.length, 1);
    assert.deepEqual(s.enrollmentUpdates, [true]);
});

for (const failure of ['network', 'unauthorized', 'malformed']) {
    test(`unreadable security (${failure}) stops before confirmation`, async () => {
        const s = setup({ hasPin: null, fetch: async () => {
            if (failure === 'network') throw new Error('Unavailable');
            return { ok: failure !== 'unauthorized', json: async () => ({ success: true, hasPin: failure === 'malformed' ? 'yes' : true }) };
        } });
        await s.confirm(action());
        assert.deepEqual(s.calls.map((c) => c.url), ['/api/consumer/security']);
        assert.equal(s.prompts.length, 0);
        assert.equal(s.lock.current, false);
        assert.ok(s.messages[0].text.startsWith('⚠️'));
    });
}

test('accounts without an enrolled PIN keep the bootstrap flow', async () => {
    const s = setup({ hasPin: false });
    await s.confirm(action('send'));
    assert.equal(s.prompts.length, 0);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].init.headers['x-consumer-pin'], undefined);
});

test('explicit request with an unresolved own wallet conservatively prompts', async () => {
    const s = setup({ ownWallet: null });
    await s.confirm(action('request', own));
    assert.equal(s.prompts.length, 1);
});

test('server step-up rejection refreshes enrollment next time, without automatic retry', async () => {
    const s = setup({ fetch: async () => ({ ok: false, json: async () => ({ success: false, code: 'STEP_UP_REQUIRED', error: 'Payment PIN required.' }) }) });
    await s.confirm(action());
    assert.deepEqual(s.enrollmentUpdates, [null]);
    assert.equal(s.calls.length, 1);
    assert.equal(s.messages.length, 1);
    assert.ok(s.messages[0].text.startsWith('⚠️'));
});

test('re-entry while the PIN dialog is open cannot replace it or submit twice', async () => {
    let resolve;
    const pending = new Promise((r) => { resolve = r; });
    const s = setup({ requestPin: () => pending });
    const first = s.confirm(action('send'));
    await s.confirm(action('send'));
    assert.equal(s.prompts.length, 1);
    assert.equal(s.calls.length, 0);
    resolve(syntheticCredential);
    await first;
    assert.equal(s.calls.length, 1);
    assert.equal(s.lock.current, false);
});

test('a network failure after confirmation does not retry or expose the proof', async () => {
    const s = setup({ fetch: async () => { throw new Error('Request failed'); } });
    await s.confirm(action());
    assert.equal(s.calls.length, 1);
    assert.equal(s.lock.current, false);
    assert.ok(!JSON.stringify(s.messages).includes(syntheticCredential));
});
