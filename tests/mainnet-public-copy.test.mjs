// Copy regressions only: real SSR components, the CTA's actual section JSX
// and static route/data checks. Not browser, uptime or settlement proof.
// Run: npx tsx --test tests/mainnet-public-copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import Link from 'next/link';
import Reveal from '../src/components/home/Reveal.tsx';
import Hero from '../src/components/home/Hero.tsx';
import ProductGrid from '../src/components/home/ProductGrid.tsx';
import AgentRail from '../src/components/home/AgentRail.tsx';
import DevSplit from '../src/components/home/DevSplit.tsx';
import SystemFlow from '../src/components/home/SystemFlow.tsx';
import ApiDocsPage from '../src/app/docs/api/page.tsx';
import MerchantDocsPage from '../src/app/docs/merchant/page.tsx';
import AgentDocsPage from '../src/app/docs/agents/page.tsx';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const text = (component) => renderToStaticMarkup(React.createElement(component)).replace(/<[^>]*>/g, ' ');

// Standalone Node loading of next/image differs from the Next webpack boundary.
// Render the exact CTA section (no image/footer) with its real Link and Reveal,
// rather than changing production imports or copying its customer-facing text.
const closingSource = read('src/components/home/ClosingCTA.tsx');
const closingAst = ts.createSourceFile('ClosingCTA.tsx', closingSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const closingSections = [];
function findClosingSection(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(closingAst) === 'section') closingSections.push(node.getText(closingAst));
  ts.forEachChild(node, findClosingSection);
}
findClosingSection(closingAst);
assert.equal(closingSections.length, 1);
const closingCompiled = ts.transpileModule(`return function ClosingCtaSection() { return (${closingSections[0]}); };`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const ClosingCtaSection = new Function('React', 'Reveal', 'Link', closingCompiled)(React, Reveal, Link);

test('checkout hero describes direct merchant payment without a fabricated escrow or reputation', () => {
  const html = text(Hero);
  assert.match(html, /Customers pay directly|Customers pay|Customers/i);
  assert.match(html, /merchant wallet; FlareHQ never holds checkout funds/);
  assert.match(html, /EXAMPLE FLOW/);
  assert.doesNotMatch(html, /rep 92|held \$250|Agent hired|Live on/);
});

test('product cards disclose mainnet escrow, job-stream and execution limitations', () => {
  const html = text(ProductGrid);
  assert.match(html, /unavailable on mainnet/);
  assert.match(html, /Legacy per-second streams are disabled/);
  assert.match(html, /Mainnet transfer completion awaits an owner-run test/);
  assert.doesNotMatch(html, /strong today|Only real, live|Open live/);
});

test('agent rail distinguishes all identifiers, honest scores and unavailable job/Brain calls', () => {
  const html = text(AgentRail);
  for (const value of ['Registry ID', 'ERC-8004 token ID', 'SCA wallet', 'backend-supplied', 'disabled on mainnet', 'unavailable on mainnet']) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, /Streaming wages|Scores 0–100 with validator-signed trust/);
});

test('developer sample is not a mainnet x402 quickstart or a fabricated receipt', () => {
  const html = text(DevSplit);
  assert.match(html, /Mainnet x402 remains disabled/);
  assert.match(html, /Illustrative receipt — not a verified transaction/);
  assert.match(html, /server-side verification/);
  assert.doesNotMatch(html, /pay \$0\.002|0x7f|five minutes/);
});

test('Telegram CTA does not promise a funded mainnet job and uses semantic job IDs', () => {
  const html = text(ClosingCtaSection);
  assert.match(html, /Mainnet accept, fund and completion actions are unavailable without ERC-8183/);
  assert.match(html, /example: job42/);
  assert.doesNotMatch(html, /funded \$250|\/apply #4821|Earn USDC from agent jobs/);
});

test('system animation labels the job lifecycle illustrative and testnet-only', () => {
  const html = text(SystemFlow);
  assert.match(html, /Testnet job lifecycle — mainnet ERC-8183 unavailable/);
  assert.match(html, /Illustrative on-chain job lifecycle/);
  assert.match(html, /x402: mainnet disabled/);
  assert.doesNotMatch(html, /Live economic flow|Every job moves the same way/);
});

test('every persona tab has truthful copy, including tabs not rendered by initial SSR', () => {
  const source = read('src/components/home/PersonaTabs.tsx');
  const ast = ts.createSourceFile('PersonaTabs.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'TABS') declaration = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration && ts.isArrayLiteralExpression(declaration));
  const javascript = ts.transpileModule(`return (${declaration.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const tabs = new Function(javascript)();
  assert.equal(tabs.length, 4);
  const agents = tabs.find((tab) => tab.id === 'agents');
  assert.match(agents.desc, /jobs, escrow and job streams are unavailable; x402 is disabled/);
  assert.match(tabs.find((tab) => tab.id === 'developers').desc, /availability requirements/);
  assert.match(tabs.find((tab) => tab.id === 'individuals').desc, /sends and savings retain payment-code checks/);
  assert.doesNotMatch(JSON.stringify(tabs), /Mainnet-ready APIs|\$0\.002 x402 billing|streaming wages/i);
});

test('built-in API docs distinguish retired streams, job tranches and x402 wallet requirements', () => {
  const html = text(ApiDocsPage);
  for (const value of ['503 escrow_unavailable', 'FUNDED job', 'not a refund to the poster', 'Retired per-second streams', '503 stream_unavailable', '503 x402_unavailable', 'EOAs, not Circle SCAs']) {
    assert.ok(html.includes(value), value);
  }
});

test('merchant docs no longer badge every operation Live', () => {
  const html = text(MerchantDocsPage);
  assert.match(html, /Mainnet unavailable/);
  assert.match(html, /Owner verification pending/);
  assert.match(html, /FlareHQ never holds checkout funds/);
  assert.doesNotMatch(html, /\bLive\b|Create continuous USDC payment streams/);
});

test('agent docs separate identity, treasury, EOA and ERC-8183 availability', () => {
  const html = text(AgentDocsPage);
  for (const value of ['Registry ID', 'ERC-8004 token ID', 'SCA wallet', 'separate EOA', 'x402 is disabled', 'Read-only job lists and pre-chain postings remain available']) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, /All agent wallets are Circle/);
});

test('overview network resolves at request time rather than freezing the build network', () => {
  const source = read('src/app/docs/page.tsx');
  assert.ok(source.includes('export default async function DocsPage'));
  assert.ok(source.indexOf('await connection()') < source.indexOf('const network = getNetworkConfig()'));
  assert.ok(source.includes('disabled on mainnet pending end-to-end integration review'));
  assert.ok(source.includes('legacy per-second streams are retired'));
  const layout = read('src/app/docs/layout.tsx');
  assert.ok(layout.includes('export default async function DocsLayout'));
  assert.ok(layout.indexOf('await connection()') < layout.indexOf('Built on {arcLabel()}'));
});
