// Actual display helpers/badge and production page JSX with injected hooks.
// Offline only: effects never run; no auth, DB, RPC, wallets or funds.
// Run: npx tsx --test tests/merchant-payment-display.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import PaymentStatusBadge from '../src/components/PaymentStatusBadge.tsx';
import {
  countPaymentStatuses,
  paymentStatusCategory,
  paymentStatusLabel,
} from '../src/lib/payments/statusDisplay.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const noop = () => {};
const plain = ({ children }) => React.createElement('div', null, children);
const chart = ({ children }) => React.createElement('svg', null, children);
const Link = ({ children, ...props }) => React.createElement('a', props, children);
const Image = (props) => React.createElement('img', props);

// Strip imports and inject named hook values, not copies of the page markup.
// All conditionals, labels, card definitions, styles and event handlers below
// are compiled directly from the current production component's source.
function componentForRender(path, states, dependencies = {}, writes = []) {
  const hooks = {
    React,
    useState: (name, initial) => [
      Object.hasOwn(states, name) ? states[name] : typeof initial === 'function' ? initial() : initial,
      (value) => writes.push({ name, value }),
    ],
    useEffect: noop,
    useRef: (current) => ({ current }),
    useRouter: () => ({ push: noop, replace: noop }),
    ...dependencies,
  };
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const source = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,
    ast.statements.filter((node) => !ts.isImportDeclaration(node))));
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
    },
    transformers: {
      before: [(context) => {
        const visit = (node) => {
          if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
            && node.initializer && ts.isCallExpression(node.initializer)
            && node.initializer.expression.getText() === 'useState') {
            const stateName = node.name.elements[0].name.getText();
            return context.factory.updateVariableDeclaration(node, node.name,
              node.exclamationToken, node.type,
              context.factory.updateCallExpression(node.initializer,
                node.initializer.expression, node.initializer.typeArguments,
                [context.factory.createStringLiteral(stateName), ...node.initializer.arguments]));
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (source) => ts.visitNode(source, visit);
      }],
    },
  }).outputText;
  const exports = {};
  new Function('exports', ...Object.keys(hooks), compiled)(exports, ...Object.values(hooks));
  return exports.default;
}

const payments = Object.freeze(['SUCCESS', 'PENDING', 'EXPIRED', 'FAILED', 'FUTURE_STATUS'].map((status, index) => Object.freeze({
  id: `offline-${index}`, reference: `offline_invoice_${index}`, amount: 0.01,
  currency: 'USDC', chain: 'Arc v1.0', status, sender_email: null,
  merchant: 'Offline merchant', paid_at: '2026-11-19T09:00:00.000Z',
  arc_tx_hash: null, explorer_url: null, gateway_reference: null,
})));
const merchant = Object.freeze({ businessName: 'OfflineMerchant'.repeat(8), email: 'offline@example.invalid', apiKeyHint: null });
const dashboardStates = {
  checkingAuth: false, loading: false, merchant, payments, isMobile: true,
  metrics: { totalVolume: 0.01, volumeByCurrency: { USDC: 0.01, EURC: 0 }, successRate: 20, totalTransactions: 5 },
};
const dashboardDeps = {
  DashboardSidebar: () => null, Image, PaymentStatusBadge, countPaymentStatuses,
  displayChain: (chain) => chain,
  AreaChart: chart, ResponsiveContainer: plain,
  Area: () => null, XAxis: () => null, YAxis: () => null,
  CartesianGrid: () => null, Tooltip: () => null,
};
const renderDashboard = (states = {}) => renderToStaticMarkup(React.createElement(
  componentForRender('src/app/merchant/dashboard/page.tsx', { ...dashboardStates, ...states }, dashboardDeps),
));
const renderTransactions = (rows) => renderToStaticMarkup(React.createElement(
  componentForRender('src/app/transactions/page.tsx', { loading: false, payments: rows }, {
    DashboardSidebar: () => null, PaymentStatusBadge, displayChain: (chain) => chain,
  }),
));
const sidebar = (states, writes = []) => componentForRender('src/components/DashboardSidebar.tsx', states, {
  Image, Link, useNetwork: () => ({ label: 'Arc', isTestnet: false }),
}, writes);

for (const [category, codes] of Object.entries({
  success: ['SUCCESS', 'COMPLETED', 'EXECUTED'],
  pending: ['PENDING', 'PROCESSING_ONCHAIN'],
  expired: ['EXPIRED'],
  failed: ['FAILED', 'SETTLEMENT_ERROR', 'ATTESTATION_FAILED'],
})) {
  test(`${category} categorization accepts only its known codes`, () => {
    for (const code of codes) {
      assert.equal(paymentStatusCategory(code), category);
      assert.equal(paymentStatusCategory(`  ${code.toLowerCase()}  `), category);
    }
  });
}

test('unknown/missing statuses do not silently become pending or failed', () => {
  for (const status of [undefined, null, '', 'FUTURE_STATUS', 123]) {
    assert.equal(paymentStatusCategory(status), 'unknown');
    assert.equal(paymentStatusLabel(status), String(status ?? ''));
  }
  assert.equal(paymentStatusLabel(' future_status '), ' future_status ');
});

test('all existing display labels are preserved', () => {
  assert.equal(paymentStatusLabel('SUCCESS'), 'Sent');
  assert.equal(paymentStatusLabel('FAILED'), 'Failed — no money moved');
  assert.equal(paymentStatusLabel('PROCESSING_ONCHAIN'), 'Pending — no transaction yet');
  assert.equal(paymentStatusLabel('EXPIRED'), 'Expired — link no longer valid');
});

test('expired-only invoices contribute zero to failed/pending counts', () => {
  assert.deepEqual(countPaymentStatuses(['EXPIRED', ' expired ']), {
    success: 0, pending: 0, failed: 0, expired: 2, unknown: 0,
  });
});

test('empty and generator inputs count every display status once', () => {
  assert.deepEqual(countPaymentStatuses([]), { success: 0, pending: 0, failed: 0, expired: 0, unknown: 0 });
  function* statuses() { for (const payment of payments) yield payment.status; }
  const counts = countPaymentStatuses(statuses());
  assert.deepEqual(counts, { success: 1, pending: 1, failed: 1, expired: 1, unknown: 1 });
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), payments.length);
});

test('display counting/rendering never changes the supplied ledger rows', () => {
  const before = JSON.stringify(payments);
  countPaymentStatuses(payments.map((payment) => payment.status));
  renderDashboard();
  renderTransactions(payments);
  assert.equal(JSON.stringify(payments), before);
});

for (const [status, category, palette] of [
  ['SUCCESS', 'success', 'emerald'], ['PENDING', 'pending', 'amber'],
  ['FAILED', 'failed', 'red'], ['EXPIRED', 'expired', 'slate'],
  ['FUTURE_STATUS', 'unknown', 'slate'],
]) {
  test(`${status} badge renders the shared label and ${palette} palette`, () => {
    const html = renderToStaticMarkup(React.createElement(PaymentStatusBadge, { status }));
    assert.match(html, new RegExp(`data-payment-status="${category}"`));
    assert.match(html, new RegExp(`bg-${palette}-`));
    assert.ok(html.includes(paymentStatusLabel(status)));
    if (category === 'expired' || category === 'unknown') assert.doesNotMatch(html, /(?:bg|text|border)-red-/);
  });
}

test('dashboard renders separate expired/failed/pending/other cards from the same statuses', () => {
  const html = renderDashboard();
  for (const label of ['Successful', 'Pending', 'Expired', 'Failed', 'Other']) {
    const card = html.match(new RegExp(`data-payment-count="${label}"[\\s\\S]*?<p[^>]*>${label}</p>[\\s\\S]*?<p[^>]*>(\\d+)</p>`));
    assert.ok(card, `missing ${label} card`);
    assert.equal(card[1], '1');
  }
  assert.match(html, /data-payment-status="expired"[^>]*bg-slate-/);
  assert.match(html, /data-payment-status="failed"[^>]*bg-red-/);
});

test('dashboard does not show an Other card when every status is recognized', () => {
  assert.doesNotMatch(renderDashboard({ payments: payments.slice(0, 4) }), /data-payment-count="Other"/);
});

test('mobile greeting reserves menu clearance in CSS, including the pre-effect render', () => {
  const beforeResizeEffect = renderDashboard({ isMobile: false });
  const mobile = renderDashboard({ isMobile: true });
  for (const html of [beforeResizeEffect, mobile]) {
    const main = html.match(/<main([^>]*)>/)[1];
    assert.match(main, /class="[^"]*min-w-0[^"]*pt-20[^"]*md:p-8/);
    assert.doesNotMatch(main, /style="[^"]*padding/);
    assert.match(html, /<h1[^>]*overflow-wrap:anywhere/);
    assert.ok(html.includes(`Welcome back, ${merchant.businessName}`));
  }
});

test('mobile status grid uses bounded columns, and desktop fits three per row', () => {
  assert.match(renderDashboard({ isMobile: true }), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(renderDashboard({ isMobile: false }), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('transaction desktop rows and mobile cards share neutral expiry/red failure badges', () => {
  const html = renderTransactions(payments);
  assert.equal((html.match(/data-payment-status="expired"/g) ?? []).length, 2);
  assert.equal((html.match(/data-payment-status="failed"/g) ?? []).length, 2);
  assert.equal((html.match(/Expired — link no longer valid/g) ?? []).length, 2);
  assert.match(html, /data-payment-status="expired"[^>]*bg-slate-/);
  assert.match(html, /data-payment-status="failed"[^>]*bg-red-/);
});

test('transaction main allows the desktop table to scroll within the available width', () => {
  const html = renderTransactions(payments);
  assert.match(html, /<main class="[^"]*min-w-0/);
  assert.match(html, /class="hidden md:block overflow-x-auto"/);
});

test('expired transactions keep no payable/copy-link action', () => {
  const html = renderTransactions(payments.filter((payment) => payment.status === 'EXPIRED'));
  assert.doesNotMatch(html, /Copy Link|Copy Payment Link/);
  const pending = renderTransactions(payments.filter((payment) => payment.status === 'PENDING'));
  assert.match(pending, /Copy Link/);
  assert.match(pending, /Copy Payment Link/);
});

function findElement(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

test('mobile menu exposes a labeled open control and matching navigation target', () => {
  const writes = [];
  const tree = sidebar({ isMobile: true, open: false }, writes)({ active: 'Dashboard' });
  const control = findElement(tree, (node) => node.props['aria-label'] === 'Open navigation');
  assert.ok(control);
  assert.equal(control.props.type, 'button');
  assert.equal(control.props['aria-expanded'], false);
  assert.ok(findElement(tree, (node) => node.props.id === control.props['aria-controls']));
  assert.equal(control.props.style.top + control.props.style.height, 56);
  control.props.onClick();
  assert.deepEqual(writes, [{ name: 'open', value: true }]);
});

test('mobile menu has a labeled close control that cannot shrink away', () => {
  const writes = [];
  const tree = sidebar({ isMobile: true, open: true }, writes)({ active: 'Dashboard' });
  const control = findElement(tree, (node) => node.props['aria-label'] === 'Close navigation');
  assert.ok(control);
  assert.equal(control.props.type, 'button');
  assert.equal(control.props.style.flexShrink, 0);
  assert.equal(control.props.style.height, 40);
  control.props.onClick();
  assert.deepEqual(writes, [{ name: 'open', value: false }]);
});

test('desktop sidebar retains navigation without mobile open/close controls', () => {
  const html = renderToStaticMarkup(React.createElement(sidebar({ isMobile: false, open: false }), { active: 'Dashboard' }));
  assert.match(html, /id="merchant-dashboard-navigation"/);
  assert.doesNotMatch(html, /aria-label="(?:Open|Close) navigation"/);
});
