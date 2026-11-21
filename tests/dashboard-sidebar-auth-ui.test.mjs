// Render the real client components with only Next routing/image and network
// context mocked. No browser, database, credentials, API calls or transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function render(path, props = {}, states = {}, network = { isTestnet: false }) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    let stateIndex = 0;
    const react = { ...React, useState(initial) {
        const index = stateIndex++;
        return React.useState(Object.hasOwn(states, index) ? states[index] : initial);
    } };
    const mockedRequire = (id) => {
        if (id === 'react') return react;
        if (id === 'next/image') return { __esModule: true, default: ({ priority, ...p }) => React.createElement('img', p) };
        if (id === 'next/link') return { __esModule: true, default: (p) => React.createElement('a', p) };
        if (id === 'next/navigation') return { useRouter: () => ({}), useSearchParams: () => new URLSearchParams() };
        if (id.endsWith('/NetworkContext')) return { useNetwork: () => network, useArcLabel: () => 'Arc' };
        return require(id);
    };
    const compiled = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(mockedRequire, module, module.exports);
    return renderToStaticMarkup(React.createElement(module.exports.default, props));
}

for (const path of ['src/app/merchant/login/page.tsx', 'src/app/merchant/signup/page.tsx', 'src/app/start/page.tsx', 'src/app/merchant/forgot-password/page.tsx']) {
    test(`${path} renders exactly one logo and retains navigation`, () => {
        const html = render(path);
        assert.equal((html.match(/<img\b/g) ?? []).length, 1);
        assert.match(html, path.includes('forgot-password') ? /href="\/merchant\/login"/ : /href="\/"/);
    });
}

for (const step of ['verify', 'done']) {
    test(`signup ${step} renders one logo, not the form header too`, () => {
        const html = render('src/app/merchant/signup/page.tsx', {}, { 0: step, 5: 'synthetic-key-not-a-real-credential' });
        assert.equal((html.match(/<img\b/g) ?? []).length, 1);
        assert.match(html, step === 'verify' ? /Check your email/ : /Account Verified/);
    });
}

for (const compact of [false, true]) {
    test(`sidebar ${compact ? 'collapsed' : 'expanded'} retains labeled links, controls and one logo`, () => {
        const html = render('src/components/DashboardSidebar.tsx', { active: 'Escrow' }, { 2: compact });
        assert.match(html, new RegExp(`aria-label="${compact ? 'Expand' : 'Collapse'} sidebar"`));
        assert.match(html, new RegExp(`aria-expanded="${!compact}"`));
        assert.match(html, /aria-label="Escrow" aria-current="page"/);
        assert.match(html, /aria-label="Settings"/);
        assert.match(html, /aria-label="Sign out"/);
        assert.equal((html.match(/<img\b/g) ?? []).length, 1);
        assert.doesNotMatch(html, /Arc.*Mode|Testnet Mode|faucet.circle.com/);
        assert.match(html, /data-sidebar-scroll="true"[^>]*overflow-y:auto/);
        assert.ok(html.indexOf('Collapse sidebar') < html.indexOf('data-sidebar-scroll') || compact);
        assert.match(html, compact ? /width:72px/ : /width:220px/);
    });
}

test('mobile retains the drawer controls even with a saved desktop collapse preference', () => {
    const html = render('src/components/DashboardSidebar.tsx', { active: 'Escrow' }, { 0: true, 1: true, 2: true });
    assert.match(html, /aria-label="Close navigation"/);
    assert.doesNotMatch(html, /aria-label="(?:Collapse|Expand) sidebar"/);
    assert.match(html, /width:220px/);
    assert.match(html, />Escrow<\/span>/);
});

test('testnet faucet remains available without the removed network-mode badge', () => {
    const html = render('src/components/DashboardSidebar.tsx', { active: 'Escrow' }, {}, { isTestnet: true });
    assert.match(html, /Get Test Tokens/);
    assert.match(html, /href="https:\/\/faucet.circle.com\/"/);
    assert.doesNotMatch(html, /Arc.*Mode|Testnet Mode/);
});
