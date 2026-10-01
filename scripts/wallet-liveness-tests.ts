// scripts/wallet-liveness-tests.ts
//
// Mainnet wallet display gate (liveness) — pure + static tests only.
// No DB, no Circle, no network, no fund movement: the live ARC/LIVE proof
// for the migrated rows was done by hand via read-only getWallet (see the
// commit body), never by an automated live call.
//
// Run: npx tsx scripts/wallet-liveness-tests.ts
//
// Covers:
//   1. Liveness helper contract (read-only getWallet, 10-min TTL, never
//      throws, chain compared to network config, off-mainnet checked:false).
//   2. Route wiring (session GET, email-auth PUT, external destination
//      preview + intent, merchant wallet GET: 409 WALLET_NEEDS_UPDATE with
//      NO address, walletVerified flag, mainnet-only gating).
//   3. Telegram gap closed (existing-account login runs the Step-C
//      migration, token bound to the post-migration address).
//   4. Badge (exact "Arc Mainnet ✓ verified" copy, server-flag-gated,
//      nothing on testnet).
//   5. No fund movement (no createWallets/createWalletSet/transfer/sign in
//      the helper; no default-payer fallback reintroduced).

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WALLET_CHECK_FAILED_CODE,
  WALLET_CHECK_RETRY_MESSAGE,
  WALLET_LIVENESS_TTL_MS,
  WALLET_NEEDS_UPDATE_MESSAGE,
  __clearWalletLivenessCacheForTests,
  checkCircleWalletLiveness,
  classifyWalletRecord,
} from '@/src/lib/wallets/liveness';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const NEEDS_UPDATE = 'Your wallet needs updating, please log in again.';
const RETRY = 'Could not verify your wallet right now. Try again.';
const BADGE = 'Arc Mainnet ✓ verified';

console.log('── 1: liveness helper contract ───────────────────────────────');
ok('TTL is exactly 10 minutes', WALLET_LIVENESS_TTL_MS === 10 * 60 * 1000, String(WALLET_LIVENESS_TTL_MS));
ok('exact needs-update copy (single authority)', WALLET_NEEDS_UPDATE_MESSAGE === NEEDS_UPDATE);
ok('exact retry copy (single authority)', WALLET_CHECK_RETRY_MESSAGE === RETRY);
ok('retry code matches send-path asserts', WALLET_CHECK_FAILED_CODE === 'WALLET_CHECK_FAILED');
const liveSrc = read('src/lib/wallets/liveness.ts');
// Comment-stripped source for banned-token checks (rule comments name the
// forbidden calls so humans don't add them — comments must not trip the test).
const liveCode = liveSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');
ok('read-only: uses getWallet', liveCode.includes('getWallet({ id: circleWalletId })'));
for (const banned of ['createWallets', 'createWalletSet', 'transferUsdc', 'createContractExecutionTransaction', 'CIRCLE_WALLET_SET_ID', 'DEFAULT_PAYER_WALLET_ID']) {
  ok(`no fund/mint path: ${banned}`, !liveCode.includes(banned), 'present');
}
ok('never throws (catch → stale/unknown verdict)', /catch \(err\) \{[\s\S]*?isCircleClean404\(err\) \? staleResult\(\) : unknownResult\(\)/.test(liveSrc));
ok('chain compared to network config (no hardcoded chain)', liveCode.includes('getNetworkConfig().circleBlockchain'));
ok('LIVE state required for live verdict', liveCode.includes('"LIVE"'));
ok('address must match the DB row when given', liveCode.includes('String(expectedAddress).toLowerCase()'));
ok('off-mainnet: no check, checked:false', liveSrc.includes(`getArcNetworkName() !== "mainnet"`) && liveSrc.includes('checked: false'));
ok('cache clear seam for tests', typeof __clearWalletLivenessCacheForTests === 'function');

// Off-mainnet (this process has no ARC_NETWORK=mainnet): must NOT call
// Circle and must report checked:false — proves the testnet no-op path.
const offMainnet = await checkCircleWalletLiveness('00000000-0000-4000-8000-000000000000', '0x0000000000000000000000000000000000000000');
ok('off-mainnet returns checked:false without Circle', offMainnet.checked === false && offMainnet.live === false);
const nullId = await checkCircleWalletLiveness(null);
ok('null wallet id → not live (no throw)', nullId.live === false);

console.log('── 1b: stale vs transient verdicts (pure) ────────────────────');
const ARC = 'ARC';
const GOOD = { blockchain: 'ARC', state: 'LIVE', address: '0xabc0000000000000000000000000000000000001', walletSetId: 'set-1' };
ok('ARC+LIVE+matching address → live', classifyWalletRecord(GOOD, ARC, GOOD.address) === 'live');
ok('ARC+LIVE, no expected address → live', classifyWalletRecord(GOOD, ARC, null) === 'live');
ok('wrong chain (ARC-TESTNET on mainnet) → stale', classifyWalletRecord({ ...GOOD, blockchain: 'ARC-TESTNET' }, ARC, GOOD.address) === 'stale');
ok('wrong chain (foreign chain) → stale', classifyWalletRecord({ ...GOOD, blockchain: 'ETH' }, ARC, GOOD.address) === 'stale');
ok('non-LIVE state → unknown (retry, NOT stale)', classifyWalletRecord({ ...GOOD, state: 'FROZEN' }, ARC, GOOD.address) === 'unknown');
ok('address mismatch → unknown (retry, NOT stale)', classifyWalletRecord(GOOD, ARC, '0xabc0000000000000000000000000000000000002') === 'unknown');
ok('missing record → unknown (NOT stale)', classifyWalletRecord(null, ARC, GOOD.address) === 'unknown');
ok('chain compare is exact (no prefix/substring match)', classifyWalletRecord({ ...GOOD, blockchain: 'ARC-TESTNET' }, ARC, null) === 'stale');
// Error classification reuses the migration clean-404 gate (single
// authority): only a clean 404 is stale; 5xx/timeout/network never are.
ok('stale errors reuse isCircleClean404', liveSrc.includes('isCircleClean404(err) ? staleResult() : unknownResult()'));
ok('transient unknowns are never cached (next display retries)', /if \(result\.verdict !== "unknown"\) \{[\s\S]*?cache\.set/.test(liveSrc));

console.log('── 2: route wiring ───────────────────────────────────────────');
const session = read('src/app/api/consumer/session/route.ts');
ok('session GET: mainnet-gated gate', session.includes(`getArcNetworkName() === 'mainnet'`));
ok('session GET: 409 WALLET_NEEDS_UPDATE hides address', session.includes(`code: 'WALLET_NEEDS_UPDATE'`) && session.includes('status: 409'));
ok('session GET: transient → 503 retry (never needs-update)', session.includes('WALLET_CHECK_FAILED_CODE') && session.includes('status: 503') && session.includes('WALLET_CHECK_RETRY_MESSAGE'));
ok('session GET: stale-gated branch (if (!live.stale))', session.includes('if (!live.stale)'));
ok('session GET: walletVerified flag', session.includes('walletVerified'));
ok('session GET: login POST never claims verified', session.includes('walletVerified: false'));
ok('session GET: shared copy (no literal duplicate)', session.includes('WALLET_NEEDS_UPDATE_MESSAGE') && !session.includes(NEEDS_UPDATE));

const emailAuth = read('src/app/api/consumer/email-auth/route.ts');
ok('email-auth PUT: liveness gate before serving address', emailAuth.includes('checkCircleWalletLiveness(account.circleWalletId, account.walletAddress)'));
ok('email-auth PUT: 409 without address on stale', emailAuth.includes(`code: "WALLET_NEEDS_UPDATE"`) && emailAuth.includes('status: 409'));
ok('email-auth PUT: transient → 503 retry, no session', emailAuth.includes('WALLET_CHECK_FAILED_CODE') && emailAuth.includes('status: 503'));
ok('email-auth PUT: walletVerified flag', emailAuth.includes('walletVerified'));
ok('email-auth PUT: shared copy (no literal duplicate)', emailAuth.includes('WALLET_NEEDS_UPDATE_MESSAGE'));

const dest = read('src/app/api/cctp/transfer/external/destination/route.ts');
ok('destination preview: liveness gate on linked wallet', dest.includes('checkCircleWalletLiveness(dest.circleWalletId, dest.destination)'));
ok('destination preview: 409 hides destination', dest.includes(`code: 'WALLET_NEEDS_UPDATE'`) && dest.includes('status: 409'));
ok('destination preview: transient → 503 retry', dest.includes('WALLET_CHECK_FAILED_CODE') && dest.includes('status: 503'));
ok('destination preview: walletVerified flag', dest.includes('walletVerified'));

const intent = read('src/app/api/cctp/transfer/external/intent/route.ts');
ok('intent: sink gate (no bridge into dead wallet)', intent.includes('checkCircleWalletLiveness(dest.circleWalletId, dest.destination)'));
ok('intent: 409 WALLET_NEEDS_UPDATE', intent.includes(`code: 'WALLET_NEEDS_UPDATE'`) && intent.includes('status: 409'));
ok('intent: transient → 503 retry, no intent recorded', intent.includes('WALLET_CHECK_FAILED_CODE') && intent.includes('status: 503'));

const merchWallet = read('src/app/api/merchant/wallet/route.ts');
ok('merchant wallet GET: liveness gate', merchWallet.includes('checkCircleWalletLiveness(merchant.circleWalletId, merchant.walletAddress)'));
ok('merchant wallet GET: 409 hides payout address', merchWallet.includes(`code: 'WALLET_NEEDS_UPDATE'`) && merchWallet.includes('status: 409'));
ok('merchant wallet GET: transient → 503 retry', merchWallet.includes('WALLET_CHECK_FAILED_CODE') && merchWallet.includes('status: 503'));
ok('merchant wallet GET: walletVerified flag', merchWallet.includes('walletVerified'));

// The gate is read-only: provisioning stays login-only (email-auth PUT,
// merchant login, Telegram /start). Gate scopes below are handler-scoped:
// session POST Path B and merchant-wallet PATCH legitimately provision on
// their own paths — the gated GET/preview/sink handlers must never mint.
function handlerScope(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  return start >= 0 ? src.slice(start, end >= 0 ? end : undefined) : '';
}
const sessionGet = handlerScope(session, 'export async function GET', 'export async function POST');
const merchWalletGet = handlerScope(merchWallet, 'export async function GET', 'export async function PATCH');
for (const [label, src] of [['session GET', sessionGet], ['destination', dest], ['intent', intent], ['merchant-wallet GET', merchWalletGet]] as const) {
  ok(`${label}: gate provisions nothing`, !src.includes('ensureMainnet') && !src.includes('createAccountWallet('), 'provisioning present');
}

console.log('── 3: Telegram gap closed ────────────────────────────────────');
const tgAuth = read('src/lib/telegram/telegramAuth.ts');
ok('existing-account login runs Step-C migration', tgAuth.includes('ensureMainnetConsumerWallet(existing.id)'));
ok('token bound to post-migration address', tgAuth.includes('issueConsumerToken(existing.id, walletAddress,'));
ok('migration failure never blocks login', tgAuth.includes('[telegramAuth] wallet upgrade check failed'));

console.log('── 4: badge ──────────────────────────────────────────────────');
const consumerPage = read('src/app/consumer/page.tsx');
const bridge = read('src/components/bridge/ExternalBridge.tsx');
const merchSettings = read('src/app/merchant/settings/page.tsx');
for (const [label, src] of [['consumer', consumerPage], ['bridge', bridge], ['merchant-settings', merchSettings]] as const) {
  ok(`${label}: exact badge copy`, src.includes(BADGE), 'missing');
}
ok('consumer: badge needs server flag', consumerPage.includes('walletVerified && !isTestnet'));
ok('consumer: strict server-flag adoption (=== true)', consumerPage.includes('account.walletVerified === true'));
ok('consumer: stale 409 surfaces repair message', consumerPage.includes('WALLET_NEEDS_UPDATE'));
ok('consumer: transient 503 surfaces retry (never needs-update)', consumerPage.includes('WALLET_CHECK_FAILED'));
ok('bridge: badge needs server flag', bridge.includes('destinationVerified'));
ok('bridge: 409 surfaces repair message', bridge.includes(`'WALLET_NEEDS_UPDATE'`));
ok('bridge: transient surfaces retry', bridge.includes(`'WALLET_CHECK_FAILED'`));
ok('merchant-settings: badge needs server flag', merchSettings.includes('walletVerified === true'));
ok('merchant-settings: 409 hides address + shows repair', merchSettings.includes(`code === 'WALLET_NEEDS_UPDATE'`));
ok('merchant-settings: transient keeps wallet + shows retry', merchSettings.includes(`code === 'WALLET_CHECK_FAILED'`));

console.log('── 5: no fund movement / no second authorities ───────────────');
const touched = [liveSrc, session, emailAuth, dest, intent, merchWallet, tgAuth];
for (const banned of ['createWallets(', 'transferUsdc(', 'createContractExecutionTransaction(', '|| process.env.CIRCLE_WALLET_SET_ID', 'DEFAULT_PAYER']) {
  ok(`no "${banned}" in touched server paths`, !touched.some((s) => s.includes(banned)), 'present');
}
ok('no second ownership helper introduced', !liveSrc.includes('verifyCallerControlsAddress'));
for (const [label, src] of [['session', session], ['email-auth', emailAuth], ['destination', dest], ['intent', intent], ['merchant-wallet', merchWallet]] as const) {
  ok(`${label}: shared copy (no literal duplicate)`, src.includes('WALLET_NEEDS_UPDATE_MESSAGE') && !src.includes(NEEDS_UPDATE), 'literal present');
}

console.log(`\n${pass} passed, ${fail} failed${fail ? ' — ' + failures.join('; ') : ''}`);
process.exit(fail ? 1 : 0);
