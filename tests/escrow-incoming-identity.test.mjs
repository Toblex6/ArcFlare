import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = file('src/app/escrow/page.tsx');
const ast = ts.createSourceFile('escrow.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['isParty', 'viewingAddress', 'isDepositorSide', 'isBeneficiarySide', 'alreadyConfirmedByMe']);
const expressions = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) expressions.push(`const ${node.getText(ast)};`);
  ts.forEachChild(node, visit);
}
visit(ast);
const evaluate = new Function('view', 'wallet', 'selected', `${expressions.join('\n')} return {isParty, alreadyConfirmedByMe, isDepositorSide, isBeneficiarySide, buttonVisible: selected?.status === 'ACTIVE' && isParty && !alreadyConfirmedByMe};`);
const depositor = `0x${'ab'.repeat(20)}`, beneficiary = `0x${'cd'.repeat(20)}`;
const escrow = { status: 'ACTIVE', depositorSCA: depositor, beneficiarySCA: beneficiary, depositorConfirmed: true, beneficiaryConfirmed: false };

test('both sessions active: beneficiary button is visible despite depositor confirmation', () => {
  const result = evaluate('incoming', { walletAddress: depositor }, escrow);
  assert.equal(result.isDepositorSide, false); assert.equal(result.isBeneficiarySide, true);
  assert.equal(result.alreadyConfirmedByMe, false); assert.equal(result.buttonVisible, true);
  // Original expression produced true here and therefore hid the real button.
  const oldAlreadyConfirmed = (depositor === escrow.depositorSCA && escrow.depositorConfirmed) || escrow.beneficiaryConfirmed;
  assert.equal(oldAlreadyConfirmed, true);
  assert.match(source, /alreadyConfirmedByMe \? \(/); assert.match(source, /onClick=\{handleConfirmDelivery\}/);
});
test('outgoing still uses only the viewing depositor confirmation', () => {
  assert.equal(evaluate('mine', { walletAddress: depositor }, escrow).buttonVisible, false);
  assert.equal(evaluate('mine', { walletAddress: depositor }, { ...escrow, depositorConfirmed: false, beneficiaryConfirmed: true }).buttonVisible, true);
});
test('consumer-only Incoming works and beneficiary confirmation hides its own button', () => {
  assert.equal(evaluate('incoming', null, escrow).buttonVisible, true);
  assert.equal(evaluate('incoming', null, { ...escrow, beneficiaryConfirmed: true }).buttonVisible, false);
  assert.equal(evaluate('mine', { walletAddress: `0x${'ef'.repeat(20)}` }, escrow).buttonVisible, false);
});
test('consumer entry point and authenticated Incoming list no longer require a merchant session', () => {
  assert.match(file('src/app/consumer/page.tsx'), /href="\/escrow\?view=incoming"/);
  assert.match(source, /fetch\('\/api\/consumer\/session'\)/);
  const route = file('src/app/api/escrow/list/route.ts');
  assert.ok(route.indexOf("if (role === 'beneficiary')") < route.indexOf('await resolveMerchant(request)'));
  assert.match(route, /getCallerControlledAddresses\(request\)/);
  assert.match(route, /beneficiarySCA: \{ in: Array\.from\(controlled\), mode: 'insensitive' \}/);
});

// Run the real exported list handler and canonical control-set helper with
// in-memory identities. No database client, network, or credentials are loaded.
function listRoute({ merchant = false, consumer = true } = {}) {
  const queries = [];
  const owned = { reference: 'incoming-owned', beneficiarySCA: beneficiary.toUpperCase(), depositorSCA: depositor, amount: 0.05, status: 'ACTIVE', deadline: new Date(Date.now() + 60000) };
  const unrelated = { ...owned, reference: 'unrelated', beneficiarySCA: `0x${'ef'.repeat(20)}` };
  const stubs = {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/middleware/withMerchantAuth': { resolveMerchant: async () => merchant ? { id: 'merchant-a' } : null },
    '@/lib/middleware/withConsumerAuth': { resolveConsumerSession: async () => consumer ? beneficiary : null },
    '@/lib/prisma': { prisma: {
      merchant: { findUnique: async () => ({ walletAddress: depositor }) },
      x402EoaWallet: { findUnique: async () => null },
      agentRegistry: { findMany: async () => [] },
      escrow: { findMany: async (query) => { queries.push(query); return [owned, unrelated]; } },
    } },
    '@/lib/escrow/resolveBeneficiary': { beneficiaryConfirmUrl: (ref) => `/escrow/${ref}` },
    '@/lib/config/network': { explorerTxUrl: () => null },
  };
  function compile(path) {
    const module = { exports: {} };
    const code = ts.transpileModule(file(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'module', 'exports', 'console', code)((name) => {
      const key = name.replace('@/src/', '@/');
      if (!Object.hasOwn(stubs, key)) throw new Error('Unexpected dependency');
      return stubs[key];
    }, module, module.exports, { error: () => {} });
    return module.exports;
  }
  stubs['@/lib/wallet/verifyCallerControlsAddress'] = compile('src/lib/wallet/verifyCallerControlsAddress.ts');
  return { ...compile('src/app/api/escrow/list/route.ts'), queries };
}
test('real Incoming handler admits a consumer-only session and excludes unrelated beneficiaries', async () => {
  const s = listRoute();
  const response = await s.GET(new Request('https://example.test/api/escrow/list?role=beneficiary&beneficiary=foreign'));
  const body = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(body.escrows.map((e) => e.reference), ['incoming-owned']);
  assert.deepEqual(s.queries[0].where, { beneficiarySCA: { in: [beneficiary], mode: 'insensitive' } });
  assert.equal(body.metrics.total, 1); assert.equal(body.metrics.totalLocked, 0.05);
});
test('consumer-only session cannot read outgoing; anonymous Incoming performs no escrow query', async () => {
  const consumer = listRoute();
  assert.equal((await consumer.GET(new Request('https://example.test/api/escrow/list'))).status, 401);
  assert.equal(consumer.queries.length, 0);
  const anonymous = listRoute({ consumer: false });
  assert.equal((await anonymous.GET(new Request('https://example.test/api/escrow/list?role=beneficiary'))).status, 401);
  assert.equal(anonymous.queries.length, 0);
});
test('both authenticated identities contribute only controlled Incoming addresses; outgoing remains merchant-scoped', async () => {
  const s = listRoute({ merchant: true });
  assert.equal((await s.GET(new Request('https://example.test/api/escrow/list?role=beneficiary'))).status, 200);
  assert.deepEqual(s.queries[0].where.beneficiarySCA.in, [depositor, beneficiary]);
  await s.GET(new Request('https://example.test/api/escrow/list?depositor=foreign'));
  assert.deepEqual(s.queries[1].where, { merchantId: 'merchant-a' });
});

test('expired release refuses before wallet resolution, signing, RPC, or database mutation', async () => {
  const module = { exports: {} }, effects = [];
  const forbidden = async () => { effects.push('unexpected-effect'); throw new Error('Unexpected effect'); };
  const stubs = {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/prisma': { prisma: { escrow: { findUnique: async () => ({ ...escrow, reference: 'expired', contractEscrowId: 'escrow-id', deadline: new Date(0) }), update: forbidden } } },
    '@/lib/middleware/withMerchantAuth': {},
    '@/lib/wallet/resolve': { resolveWalletProvider: forbidden },
    '@/lib/wallet/verifyCallerControlsAddress': { verifyCallerControlsAddress: forbidden },
    '@/lib/auth/consumerStepUp': { requireConsumerStepUpForActor: forbidden },
    '@/lib/wallet/signatureQueue': { queueTransactionRequest: forbidden },
    '@/lib/wallet/flarehqContracts': {},
    '@/lib/wallet/chainClient': { readContractReliable: forbidden },
    '@/lib/circle/client': { createCircleClient: forbidden },
    '@/lib/config/network': {},
    '@/lib/escrow/escrowGuard': { escrowAddressOr503: () => ({ address: depositor }) },
  };
  const compiled = ts.transpileModule(file('src/app/api/escrow/release/route.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', compiled)((name) => { if (!Object.hasOwn(stubs, name)) throw new Error('Unexpected dependency'); return stubs[name]; }, module, module.exports);
  const response = await module.exports.POST(new Request('https://example.test/api/escrow/release', { method: 'POST', body: JSON.stringify({ reference: 'expired', callerSCA: beneficiary }) }));
  assert.equal(response.status, 409); assert.equal(effects.length, 0);
  assert.match(source, /disabled=\{actionLoading \|\| selected\.isExpired\}/);
});
