// Pure and static checks. No database, signing, or network requests.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutShortfall, estimatedBridgeFee, grossUpInvoiceAmount, invoiceAmountBaseUnits } from '../src/lib/checkout/bridgeGross';
import { checkoutBridgeBelongsTo, readCheckoutBridgeCredit } from '../src/lib/checkout/bridgeCredits';
import { trackCheckoutWallet } from '../src/lib/checkout/bridgeWallet';

const read = (path: string) => readFileSync(path, 'utf8');
const forwarder = (amount: unknown, token = 'USDC') => ({ type: 'forwarder', amount, token });

const token = '0x' + 'a'.repeat(40);
const hash = '0x' + 'b'.repeat(64);
const approve = { method: 'eth_sendTransaction', params: [{ to: token, data: `0x095ea7b3${'0'.repeat(128)}` }] };
const burn = { method: 'eth_sendTransaction', params: [{ to: '0x' + 'c'.repeat(40), data: '0x12345678' }] };

test('a rejected burn wallet prompt allows a retry and a submitted burn blocks a second prompt', async () => {
  const states: unknown[] = [];
  let calls = 0;
  const request = trackCheckoutWallet(async () => {
    if (++calls === 2) throw Object.assign(new Error('User rejected'), { code: 4001 });
    return hash;
  }, token, (state, txHash) => states.push([state, txHash]));
  await request(approve);
  await assert.rejects(request(burn), /User rejected/);
  await request(burn);
  await assert.rejects(request(burn), /Check the existing transfer/);
  assert.equal(calls, 3);
  assert.deepEqual(states, [
    ['uncertain', null], ['ready', null], ['uncertain', null], ['ready', null],
    ['uncertain', null], ['submitted', hash],
  ]);
});

test('USDC increaseAllowance is setup, so Bridge Kit can submit the burn afterward', async () => {
  const states: unknown[] = [];
  const allowanceHash = `0x${'a'.repeat(64)}`;
  const burnHash = `0x${'c'.repeat(64)}`;
  let calls = 0;
  const request = trackCheckoutWallet(async () => ++calls === 1 ? allowanceHash : burnHash, token, (...state) => states.push(state));

  await request({ method: 'eth_sendTransaction', params: [{ to: token, data: `0x39509351${'0'.repeat(128)}` }] });
  await request(burn);
  assert.deepEqual(states, [
    ['uncertain', null], ['ready', null],
    ['uncertain', null], ['submitted', burnHash],
  ]);
  assert.equal(calls, 2);
});

test('a concurrent prompt and a provider timeout both preserve the existing burn attempt', async () => {
  let reject!: (error: Error) => void;
  const response = new Promise((_, fail) => { reject = fail; });
  const states: unknown[] = [];
  const request = trackCheckoutWallet(() => response, token, (...state) => states.push(state));
  const pending = request(burn);
  await assert.rejects(request(burn), /Check the existing transfer/);
  reject(new Error('Wallet timed out'));
  await assert.rejects(pending, /Wallet timed out/);
  await assert.rejects(request(burn), /Check the existing transfer/);
  assert.deepEqual(states, [['uncertain', null]]);
});

test('quotes use exact USDC units and round the fee margin up', () => {
  assert.equal(invoiceAmountBaseUnits(10), 10_000_000n);
  assert.equal(estimatedBridgeFee([forwarder('0.018771'), { type: 'protocol', amount: '0.001', token: 'USDC' }]), 19_771n);
  assert.equal(grossUpInvoiceAmount(10_000_000n, 18_771n), 10_020_649n);
  assert.equal(grossUpInvoiceAmount(1n, 1n), 3n);
  assert.equal(grossUpInvoiceAmount(1n, 0n), 1n);
  for (const amount of [0, -1, Infinity, NaN]) assert.throws(() => invoiceAmountBaseUnits(amount));
  assert.throws(() => grossUpInvoiceAmount(1n, -1n));
});

for (const bad of [undefined, [], [forwarder('-1')], [forwarder('0.0000001')], [forwarder('1e3')], [forwarder(0.01)], [forwarder('1', 'ETH')]]) {
  test(`fails closed on malformed quote ${JSON.stringify(bad)}`, () => assert.throws(() => estimatedBridgeFee(bad)));
}

test('only verified invoice-scoped mints contribute to the remaining amount', async () => {
  const reference = 'invoice-1';
  const db = { flowBridgeIntent: { async findMany(query: any) {
    assert.deepEqual(query.where.OR, [{ invoiceReference: reference }, { checkoutTopUpReference: reference }]);
    assert.equal(query.where.status, 'COMPLETED');
    assert.deepEqual(query.where.mintTxHash, { not: null });
    assert.deepEqual(query.where.cctpNonce, { not: null });
    return [{ actualAmount: '600000' }, { actualAmount: '300000' }];
  } } };
  const credit = await readCheckoutBridgeCredit(db, reference);
  assert.equal(checkoutShortfall(1_000_000n, credit), 100_000n);
  assert.equal(checkoutShortfall(1_000_000n, credit + 100_000n), 0n);
  assert.equal(checkoutShortfall(1_000_000n, credit + 100_001n), 0n);
  assert.equal(checkoutBridgeBelongsTo({ invoiceReference: null, checkoutTopUpReference: reference }, reference), true);
  assert.equal(checkoutBridgeBelongsTo({ invoiceReference: 'foreign', checkoutTopUpReference: null }, reference), false);
});

const checkout = 'src/app/api/checkout/[reference]/bridge';
const intent = read(`${checkout}/intent/route.ts`);
const confirm = read(`${checkout}/confirm/route.ts`);
const complete = read(`${checkout}/complete/route.ts`);
const component = read('src/components/checkout/CheckoutCrossChain.tsx');
const widget = read('src/components/CheckoutWidget.tsx');
const externalVerify = read('src/lib/bridge/externalVerify.ts');
const confirmRoute = read(`${checkout}/confirm/route.ts`);

test('only the server-bound recipient and quoted gross reach Bridge Kit', () => {
  assert.match(intent, /const destination = invoice\.merchantSCA/);
  assert.match(intent, /quoteCheckoutBridge\(\{ source, network,/);
  assert.ok(intent.indexOf('BRIDGE_QUOTE_UNAVAILABLE') < intent.indexOf('flowBridgeIntent.create'));
  assert.match(component, /recipientAddress: created.destination/);
  assert.match(component, /amount: created.amountDisplay/);
});

test('cross-chain tab exposes wallet connector choices before a wallet is connected', () => {
  assert.match(widget, /method === 'cctp' && cctpAvailable && \([\s\S]*?!isConnected[\s\S]*?renderWalletConnectOptions\(\)[\s\S]*?<CheckoutCrossChain/);
});

test('zero-debit approval candidates can safely resume the same intent, but mismatches cannot', () => {
  assert.match(externalVerify, /reason: debited === 0n && bridgeApprovalCandidate \? 'APPROVAL_ONLY' : 'AMOUNT_MISMATCH'/);
  assert.match(confirmRoute, /safeToRetry: proof\.reason === "APPROVAL_ONLY"/);
  assert.match(component, /confirmed\?\.safeToRetry === true && confirmed\?\.reason === 'APPROVAL_ONLY'/);
  assert.match(component, /saveResume\(reference, intent, null, true\)/);
});

test('top-up requires the preceding verified mint and durable replay guards', () => {
  assert.match(intent, /current.id !== topUpAfter \|\| current.status !== "COMPLETED"/);
  assert.match(confirm, /verifyExternalBurn/);
  assert.match(confirm, /INTENT_ALREADY_USED/);
  assert.match(read('prisma/migrations/20261120030000_checkout_bridge_topups/migration.sql'), /CREATE UNIQUE INDEX .*checkoutTopUpAfter_key/);
  assert.match(read('src/app/api/cctp/transfer/external/complete/route.ts'), /intent.invoiceReference \|\| intent.checkoutTopUpReference/);
});

test('underpaid replay stays unpaid and fee handling follows verified full credit', () => {
  assert.match(complete, /fetchIrisBridgeMessage/);
  assert.match(complete, /verifyArcMint/);
  assert.match(complete, /checkoutShortfall\(invoiceUnits, credited\) === 0n/);
  assert.match(complete, /respond\(invoice.status === "SUCCESS"/);
  assert.match(complete, /code: "UNDERPAID"/);
  assert.match(complete, /marked.newlyPaid \? await/);
  assert.doesNotMatch(complete, /refund|depositForBurn/);
});
