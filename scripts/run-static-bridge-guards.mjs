// scripts/run-static-bridge-guards.mjs
// Fast, DB-free subset of consumer-external-multichain-bridge-tests.ts section 4:
// verifies the log-only instrumentation did not break bridge invariants.
// Usage: node scripts/run-static-bridge-guards.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(import.meta.url).replaceAll('\\', '/');
const src = (p) => readFileSync(new URL('../' + p, 'file://' + here), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' -- ' + detail); }
};
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const ui = src('src/components/bridge/ExternalBridge.tsx');
const verify = src('src/app/api/cctp/transfer/external/verify/route.ts');
ok('UI single kit.bridge call site', (ui.match(/\.bridge\(\{/g) ?? []).length === 1);
ok('UI retry path intact', ui.includes('kit.retry('));
ok('UI resumeOnly intact', ui.includes('resumeOnly'));
ok('UI busyRef guard intact', ui.includes('busyRef.current'));
ok('UI viem adapter intact', ui.includes('createViemAdapterFromProvider'));
ok('UI forwarder mint intact', ui.includes('useForwarder: true'));
ok('UI Arc_Testnet literal intact', ui.includes("'Arc_Testnet'"));
ok('UI chain switch before bridge', ui.indexOf('ensureOnSourceChain()') < ui.indexOf('.bridge({'));
ok('trace helper present', ui.includes('function bridgeTrace('));
for (const s of ['step-a intent created', 'step-bc kit.bridge signing start', 'step-bc kit.bridge signing THREW', 'step-bc kit.bridge signing returned', 'step-d verify POST', 'step-d verify response']) {
  ok('trace point present: ' + s, ui.includes(s), 'missing');
}
const files = [
  'src/app/api/cctp/transfer/external/intent/route.ts',
  'src/app/api/cctp/transfer/external/verify/route.ts',
  'src/app/api/cctp/transfer/external/complete/route.ts',
];
for (const p of files) {
  const s = strip(src(p));
  ok(p + ' no walletSetId', !/walletSetId/i.test(s));
  ok(p + ' no server wallet signing', !/createCircleWalletsAdapter|startBridge|createAccountWallet|CIRCLE_API_KEY|CIRCLE_ENTITY_SECRET/i.test(s));
}
ok('verify HIT log present', verify.includes('[cctp/transfer/external/verify] HIT'));
ok('verify BURN_CONFIRMED log present', verify.includes('BURN_CONFIRMED'));
ok('verify BURN_NOT_VERIFIED log present', verify.includes('BURN_NOT_VERIFIED'));
ok('verify ERROR log has reference', verify.includes('dbgReference'));
// Stall-class guards: stage logs must be awaited (fire-and-forget + immediate
// return loses the outcome row on serverless freeze → "BURN_PENDING with no
// outcome" silent stalls), and expiry must never kill an intent whose burn
// proves on-chain (late verify advances as lateRecovery).
for (const p of files) {
  const s = strip(src(p));
  const total = (s.match(/logBridgeStage\(/g) ?? []).length;
  const awaited = (s.match(/await logBridgeStage\(/g) ?? []).length;
  ok(p + ' all stage logs awaited', total > 0 && total === awaited, total + ' total, ' + awaited + ' awaited');
}
ok('verify no pre-verification expiry kill', !verify.includes('if (new Date(intent.expiresAt).getTime() < Date.now()) {'));
ok('verify late-recovery advance present', verify.includes('lateRecovery'));
ok('verify expired+unprovable still INTENT_EXPIRED', verify.includes("code: 'INTENT_EXPIRED'"));
// Completion-integrity guards (H1/M3 + attested-nonce fix): the burn's
// burn↔mint binding nonce is Circle's OFFCHAIN-assigned attested nonce
// resolved from Iris by burn hash — never decoded from MessageSent (CCTP V2
// emits EMPTY_NONCE zeros there by construction). Undecodable burns fail
// closed instead of landing destinationBound=false, and a zero placeholder
// can never satisfy a genuine mint.
const complete = src('src/app/api/cctp/transfer/external/complete/route.ts');
const extVerify = src('src/lib/bridge/externalVerify.ts');
const irisNonce = src('src/lib/bridge/irisNonce.ts');
ok('verify stores cctpNonce on BURN_CONFIRMED', verify.includes('cctpNonce'));
ok('complete binds expectedNonce', complete.includes('expectedNonce'));
ok('complete binds expectedAmount', complete.includes('expectedAmount'));
ok('complete FAILED stage carries mismatch facts', complete.includes('expectedNonce') && complete.includes('actualAmount'));
ok('complete resolves attested nonce from Iris (never the row)', complete.includes('fetchIrisBridgeMessage'));
ok('complete pins forwarder relay mint hash when Iris reports it', complete.includes('destinationMintTxHash'));
ok('complete never trusts a stored MessageSent nonce', !/expectedNonce:\s*\(intent\.cctpNonce/.test(strip(complete)));
ok('recover script resolves attested nonce from Iris', src('scripts/recover-bridge-intent.ts').includes('fetchIrisBridgeMessage'));
ok('extVerify decodes V2 DepositForBurn (minFinalityThreshold)', extVerify.includes('minFinalityThreshold'));
ok('extVerify has no V1 nonce-shaped DepositForBurn', !extVerify.includes("name: 'nonce', type: 'uint64'"));
ok('extVerify has no destinationBound:false success path', !extVerify.includes('destinationBound: false'));
ok('extVerify yields no MessageSent nonce (offchain-assigned)', !/cctpNonce:\s*(binding\.cctpNonce|msg\.nonce)/.test(strip(extVerify)));
ok('extVerify rejects the zero-placeholder nonce', extVerify.includes('EMPTY_MESSAGE_NONCE'));
ok('irisNonce documents offchain nonce assignment', irisNonce.includes('assigns CCTP V2 message nonces OFFCHAIN') || irisNonce.includes('OFFCHAIN'));
console.log('\nstatic-bridge-guards: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
