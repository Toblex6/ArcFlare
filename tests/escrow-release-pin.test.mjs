// Pure tests of the actual UI handler, following floating-assistant-step-up.
// No database, RPC, real credentials, signing or transaction submission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/app/escrow/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('escrow.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleConfirmDelivery') handler = node.initializer;
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler && ts.isArrowFunction(handler));
const compiled = ts.transpileModule(`return (${handler.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const makeHandler = new Function('selected', 'confirmingRef', 'view', 'wallet', 'setActionLoading', 'setActionError', 'fetch', 'requestPin', 'fetchEscrows', 'setSelected', compiled);
const merchant = `0x${'ab'.repeat(20)}`;
const consumer = `0x${'cd'.repeat(20)}`;
const proof = 'synthetic-step-up-proof';

function setup(options = {}) {
    const calls = [], prompts = [], errors = [], loading = [], selectedUpdates = [];
    const lock = { current: false };
    let refreshes = 0;
    const fetch = async (url, init) => {
        calls.push({ url, init });
        if (options.fetch) return options.fetch(url, init);
        return url === '/api/consumer/security'
            ? { ok: true, status: 200, json: async () => ({ success: true, hasPin: options.hasPin ?? true, walletAddress: options.sessionWallet ?? consumer }) }
            : { ok: true, status: 200, json: async () => ({ success: true, escrow: { reference: 'test-reference' } }) };
    };
    const requestPin = async (prompt) => {
        prompts.push(prompt);
        return options.requestPin ? options.requestPin(prompt) : proof;
    };
    const confirm = makeHandler({ reference: 'test-reference', beneficiarySCA: consumer }, lock,
        options.view ?? 'incoming', { walletAddress: merchant }, (v) => loading.push(v), (v) => errors.push(v),
        fetch, requestPin, async () => { refreshes++; }, (v) => selectedUpdates.push(v));
    return { confirm, calls, prompts, errors, loading, selectedUpdates, lock, refreshes: () => refreshes };
}

test('escrow mounts the shared masked dialog without persistence or logging', () => {
    assert.match(source, /import \{ useSecurePinDialog \} from '@\/components\/SecurePinDialog'/);
    assert.match(source, /dialog: pinDialog.*useSecurePinDialog/);
    assert.match(source, /\{pinDialog\}/);
    assert.doesNotMatch(handler.getText(ast), /localStorage|sessionStorage|console\.|window\.prompt/);
    const dialog = readFileSync(new URL('../src/components/SecurePinDialog.tsx', import.meta.url), 'utf8');
    assert.match(dialog, /type="password"/);
});

test('enrolled consumer is prompted before POST and proof goes only in the header', async () => {
    const s = setup();
    await s.confirm();
    assert.equal(s.prompts.length, 1);
    assert.equal(s.prompts[0].title, 'Confirm escrow delivery');
    assert.deepEqual(s.calls.map(c => c.url), ['/api/consumer/security', '/api/escrow/release']);
    assert.equal(s.calls[0].init.cache, 'no-store');
    assert.equal(s.calls[1].init.headers['x-consumer-pin'], proof);
    assert.deepEqual(JSON.parse(s.calls[1].init.body), { reference: 'test-reference', callerSCA: consumer });
    assert.ok(!s.calls[1].init.body.includes(proof));
    assert.ok(!s.calls[1].url.includes(proof));
    assert.equal(s.refreshes(), 1);
    assert.equal(s.lock.current, false);
    assert.deepEqual(s.loading, [true, false]);
});

test('cancel submits nothing and unlocks the action', async () => {
    const s = setup({ requestPin: async () => null });
    await s.confirm();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/consumer/security']);
    assert.equal(s.refreshes(), 0);
    assert.deepEqual(s.errors, [null]);
    assert.equal(s.lock.current, false);
    assert.deepEqual(s.loading, [true, false]);
});

test('second click cannot replace the PIN dialog or submit twice', async () => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const s = setup({ requestPin: () => pending });
    const first = s.confirm();
    await s.confirm();
    assert.equal(s.calls.length, 1);
    resolve(proof);
    await first;
    assert.equal(s.prompts.length, 1);
    assert.equal(s.calls.filter(c => c.url === '/api/escrow/release').length, 1);
    assert.equal(s.lock.current, false);
});

test('merchant confirmation is unchanged and never requests a consumer PIN', async () => {
    const s = setup({ view: 'mine' });
    await s.confirm();
    assert.equal(s.prompts.length, 0);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/escrow/release']);
    assert.equal(s.calls[0].init.headers['x-consumer-pin'], undefined);
    assert.equal(JSON.parse(s.calls[0].init.body).callerSCA, merchant);
});

test('unenrolled consumer keeps the server bootstrap behavior', async () => {
    const s = setup({ hasPin: false });
    await s.confirm();
    assert.equal(s.prompts.length, 0);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].init.headers['x-consumer-pin'], undefined);
});

test('session wallet matching is case insensitive', async () => {
    const s = setup({ sessionWallet: consumer.toUpperCase() });
    await s.confirm();
    assert.equal(s.prompts.length, 1);
});

test('unrelated consumer session cannot leak its proof into an owned-agent confirmation', async () => {
    const s = setup({ sessionWallet: merchant });
    await s.confirm();
    assert.equal(s.prompts.length, 0);
    assert.equal(s.calls[1].init.headers['x-consumer-pin'], undefined);
});

test('no consumer session leaves merchant-owned agent authorization to the unchanged server', async () => {
    const s = setup({ fetch: async (url) => url === '/api/consumer/security'
        ? { status: 401, ok: false }
        : { ok: true, json: async () => ({ success: true, escrow: {} }) } });
    await s.confirm();
    assert.equal(s.prompts.length, 0);
    assert.equal(s.calls.length, 2);
});

for (const failure of ['network', 'unavailable', 'malformed', 'missing-wallet']) {
    test(`security ${failure} stops before confirmation`, async () => {
        const s = setup({ fetch: async () => {
            if (failure === 'network') throw new Error('Unavailable');
            return { ok: failure !== 'unavailable', status: failure === 'unavailable' ? 503 : 200,
                json: async () => ({ success: true, hasPin: failure === 'malformed' ? 'yes' : true,
                    walletAddress: failure === 'missing-wallet' ? undefined : consumer }) };
        } });
        await s.confirm();
        assert.equal(s.calls.length, 1);
        assert.equal(s.prompts.length, 0);
        assert.ok(s.errors.at(-1));
        assert.equal(s.lock.current, false);
    });
}

for (const code of ['STEP_UP_REQUIRED', 'STEP_UP_FAILED', 'STEP_UP_LOCKED']) {
    test(`${code} is shown without retry; next click requests fresh proof`, async () => {
        const s = setup({ fetch: async (url) => url === '/api/consumer/security'
            ? { status: 200, ok: true, json: async () => ({ success: true, hasPin: true, walletAddress: consumer }) }
            : { status: 403, ok: false, json: async () => ({ success: false, code, error: 'Authorization rejected.' }) } });
        await s.confirm();
        assert.equal(s.calls.length, 2);
        assert.equal(s.refreshes(), 0);
        assert.equal(s.errors.at(-1), 'Authorization rejected.');
        await s.confirm();
        assert.equal(s.calls.length, 4);
        assert.equal(s.prompts.length, 2);
        assert.ok(!JSON.stringify(s.errors).includes(proof));
    });
}

test('server still checks canonical ownership and consumer step-up before signing', () => {
    const server = readFileSync(new URL('../src/app/api/escrow/release/route.ts', import.meta.url), 'utf8');
    assert.match(server, /verifyCallerControlsAddress\(request, callerSCA\)/);
    assert.match(server, /requireConsumerStepUpForActor\(request, actor, 'consumer\.escrow-act'\)/);
    assert.match(server, /if \(releaseStepUp\) return releaseStepUp/);
    assert.ok(server.indexOf('requireConsumerStepUpForActor(request') < server.indexOf("if (actor.type === 'merchant')"));
});

test('network failure after POST never retries or reports success', async () => {
    const s = setup({ fetch: async (url) => {
        if (url === '/api/consumer/security') return { status: 200, ok: true,
            json: async () => ({ success: true, hasPin: true, walletAddress: consumer }) };
        throw new Error('Request failed.');
    } });
    await s.confirm();
    assert.equal(s.calls.length, 2);
    assert.equal(s.refreshes(), 0);
    assert.equal(s.selectedUpdates.length, 0);
    assert.equal(s.lock.current, false);
    assert.ok(!JSON.stringify(s.errors).includes(proof));
});
