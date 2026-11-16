import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestNeedsStepUp } from '../src/lib/payments/requestStepUp';
const own = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
for (const recipient of [undefined, null, '', own, own.toUpperCase()]) {
  assert.equal(requestNeedsStepUp('request', recipient, own), false);
}
for (const recipient of [other, {}, 1]) assert.equal(requestNeedsStepUp('request', recipient, own), true);
for (const action of ['send', 'save']) {
  for (const recipient of [undefined, own, other]) assert.equal(requestNeedsStepUp(action, recipient, own), true);
}
assert.equal(requestNeedsStepUp('request', own, null), true);
const page = readFileSync('src/app/consumer/page.tsx', 'utf8');
const request = page.split('const handleRequest =')[1].split('const submitHandlers')[0];
assert.ok(!request.includes('protectedFetch') && !request.includes('requestPin'));
assert.ok(page.includes('await protectedFetch(`/api/payments/settle`'));
const server = readFileSync('src/app/api/consumer/assistant/route.ts', 'utf8');
assert.ok(server.includes("'consumer.request' as const"));
assert.ok(server.includes('payoutAddress: recipientAddress'));
assert.ok(readFileSync('src/lib/telegram/botHandlers.ts', 'utf8').includes('verifyConsumerPinForBot(confirmAccount.id, pin)'));
console.log('20 request UI/policy and gate checks passed (no DB, RPC, or funds).');
