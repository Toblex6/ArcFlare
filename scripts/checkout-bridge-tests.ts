// scripts/checkout-bridge-tests.ts
//
// Static + pure checkout cross-chain checks. No DB, no RPC, no funds.
// Proves the server-side gross-up math and that the checkout flow is wired to
// Bridge Kit / durable invoice-bound intents, not the legacy paste-hash +
// admin-key mint path.
import { readFileSync } from 'node:fs';
import {
  DEFAULT_CHECKOUT_BRIDGE_FEE_BPS,
  MAX_CHECKOUT_BRIDGE_FEE_BPS,
  parseCheckoutBridgeFeeBps,
  invoiceAmountBaseUnits,
  grossUpInvoiceAmount,
  creditSatisfiesInvoice,
} from '../src/lib/checkout/bridgeGross';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — ${detail}`); }
}
const read = (p: string) => readFileSync(p, 'utf8');

console.log('[gross-up math]');
ok('default buffer is 100 bps', DEFAULT_CHECKOUT_BRIDGE_FEE_BPS === 100);
ok('max buffer is 1000 bps', MAX_CHECKOUT_BRIDGE_FEE_BPS === 1000);
ok('unset env uses default', parseCheckoutBridgeFeeBps(undefined) === 100);
ok('empty env uses default', parseCheckoutBridgeFeeBps('') === 100);
ok('valid env accepted', parseCheckoutBridgeFeeBps('250') === 250);
ok('zero buffer accepted', parseCheckoutBridgeFeeBps('0') === 0);
for (const bad of ['-1', '10.5', 'abc', '1001', '1e3']) {
  let threw = false;
  try { parseCheckoutBridgeFeeBps(bad); } catch { threw = true; }
  ok(`rejects invalid bps "${bad}"`, threw);
}
ok('invoice 1.00 USDC → 1_000_000 units', invoiceAmountBaseUnits(1) === 1_000_000n);
ok('invoice 0.000001 USDC → 1 unit', invoiceAmountBaseUnits(0.000001) === 1n);
for (const bad of [0, -1, NaN, Infinity]) {
  let threw = false;
  try { invoiceAmountBaseUnits(bad); } catch { threw = true; }
  ok(`rejects invalid invoice amount ${String(bad)}`, threw);
}
ok('1.00 at 100 bps grosses to 1.01', grossUpInvoiceAmount(1_000_000n, 100) === 1_010_000n);
ok('1.00 at 0 bps is unchanged', grossUpInvoiceAmount(1_000_000n, 0) === 1_000_000n);
ok('buffer rounds up (1 unit at 1 bps → 2 units)', grossUpInvoiceAmount(1n, 1) === 2n);
ok('gross is always >= invoice', grossUpInvoiceAmount(123_456_789n, 250) >= 123_456_789n);
let threw = false;
try { grossUpInvoiceAmount(0n, 100); } catch { threw = true; }
ok('rejects zero invoice units', threw);
threw = false;
try { grossUpInvoiceAmount(1n, 1001); } catch { threw = true; }
ok('rejects out-of-range buffer', threw);
ok('credit equal to invoice satisfies', creditSatisfiesInvoice(1_000_000n, 1_000_000n));
ok('credit above invoice satisfies', creditSatisfiesInvoice(1_000_001n, 1_000_000n));
ok('credit below invoice does not satisfy', !creditSatisfiesInvoice(999_999n, 1_000_000n));

console.log('[wiring: no legacy path]');
const widget = read('src/components/CheckoutWidget.tsx');
const component = read('src/components/checkout/CheckoutCrossChain.tsx');
const intent = read('src/app/api/checkout/[reference]/bridge/intent/route.ts');
const confirm = read('src/app/api/checkout/[reference]/bridge/confirm/route.ts');
const complete = read('src/app/api/checkout/[reference]/bridge/complete/route.ts');
ok('checkout uses the new cross-chain component', widget.includes('<CheckoutCrossChain'));
ok('checkout no longer posts to legacy cctp-settle', !widget.includes('/api/payments/cctp-settle'));
ok('checkout no longer asks for a burn hash', !widget.includes('Burn Transaction Hash'));
ok('component drives Bridge Kit', component.includes("import('@circle-fin/bridge-kit')"));
ok('component uses forwarder destination', component.includes('useForwarder: true'));
ok('component sends to the invoice merchant', component.includes('recipientAddress: merchantSCA'));
ok('component resumes the same intent', component.includes('Resume this payment'));
ok('intent body cannot supply the destination', !intent.includes('body?.destination'));
ok('intent destination comes from invoice merchantSCA', intent.includes('const destination = invoice.merchantSCA'));
ok('intent is unique per invoice', intent.includes('invoiceReference: reference'));
ok('intent grosses up server-side', intent.includes('grossUpInvoiceAmount'));
ok('intent refuses non-USDC invoices', intent.includes('Cross-chain checkout is USDC-only'));
ok('confirm reuses the fail-closed burn verifier', confirm.includes('verifyExternalBurn'));
ok('confirm rejects a second burn hash', confirm.includes('INTENT_ALREADY_USED'));
ok('complete resolves the Circle-attested nonce', complete.includes('fetchIrisBridgeMessage'));
ok('complete verifies the Arc mint', complete.includes('verifyArcMint'));
ok('complete marks the invoice paid only after mint proof', complete.includes('status: "SUCCESS"') && complete.indexOf('verifyArcMint') < complete.indexOf('status: "SUCCESS"'));
ok('complete enforces credit >= invoice', complete.includes('creditSatisfiesInvoice'));
ok('complete preserves 25 bps platform-fee flow after verified settlement', complete.includes('settleFeeBestEffort') && complete.indexOf('verifyArcMint') < complete.indexOf('settleFeeBestEffort'));
ok('complete has no second-burn path', !complete.includes('depositForBurn') && !complete.includes('kit.bridge'));

console.log(`\ncheckout-bridge-tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
