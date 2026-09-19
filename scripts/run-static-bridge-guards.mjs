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
console.log('\nstatic-bridge-guards: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
