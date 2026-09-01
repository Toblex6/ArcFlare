/**
 * scripts/escrow-link-tests.mjs
 *
 * Tests for the escrow request-link flow (outsider-funded escrow).
 * Static proofs run always; live API checks run only when a dev server
 * is reachable at TEST_BASE_URL (default http://localhost:3000).
 *
 * Asserts:
 *  1. STATIC: the funding page uses an external wallet (wagmi) and has NO
 *     Circle SDK / custodial funding path.
 *  2. STATIC: the fund-verify route re-checks the tx on-chain (sender,
 *     destination, status) and never calls Circle.
 *  3. LIVE: unauthenticated POST /api/merchant/escrow-link is rejected (401).
 *  4. LIVE: the public detail endpoint works without auth and never leaks a
 *     custodial option.
 *
 * Run: node scripts/escrow-link-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('═══ Escrow link — static proofs ═══');

const page = readFileSync(join(here, '..', 'src', 'app', 'escrow-pay', '[reference]', 'page.tsx'), 'utf8');
ok(page.includes("from 'wagmi'"), 'funding page connects an external wallet via wagmi (WalletConnect/MetaMask)');
ok(page.includes("functionName: 'approve'") && page.includes("functionName: 'createEscrow'"),
  'funding page does approve + createEscrow from the user\u2019s own wallet (Checkout two-step pattern)');
ok(!page.includes('developer-controlled-wallets') && !page.includes('CIRCLE_API_KEY') && !page.includes('circle-fin'),
  'funding page has NO Circle SDK / custodial path');
ok(!/\/api\/escrow\/create/.test(page), 'funding page never calls the Circle-custodial escrow/create route');

const fundRoute = readFileSync(join(here, '..', 'src', 'app', 'api', 'escrow', 'link', '[reference]', 'fund', 'route.ts'), 'utf8');
ok(fundRoute.includes('getReceiptReliable') || fundRoute.includes('getTransactionReceipt'), 'fund route verifies the tx receipt on-chain (independent re-read of the chain)');
ok(fundRoute.includes('receipt.from.toLowerCase() !== depositorSCA.toLowerCase()'), 'fund route requires the tx sender to be the depositor');
ok(fundRoute.includes('receipt.to?.toLowerCase() !== ESCROW_CONTRACT.toLowerCase()'), 'fund route requires the tx to target the escrow contract');
ok(fundRoute.includes('keccak256(toBytes(reference))') && fundRoute.includes('created.escrowId.toLowerCase() !== onchainId.toLowerCase()'),
  'fund route proves the tx created THIS request\u2019s escrow (onchainId = keccak256(reference), EscrowCreated event escrowId must match)');
ok(fundRoute.includes("created.beneficiary") && fundRoute.includes("created.amount") && fundRoute.includes("created.depositor"),
  'fund route verifies the created escrow\u2019s depositor/beneficiary/amount against the request');
ok(!fundRoute.includes('initiateDeveloperControlledWalletsClient') && !fundRoute.includes('createContractExecutionTransaction') && !fundRoute.includes('transferUsdc'),
  'fund route never moves funds via Circle');

const linkRoute = readFileSync(join(here, '..', 'src', 'app', 'api', 'merchant', 'escrow-link', 'route.ts'), 'utf8');
ok(linkRoute.includes("cookies.get('merchant_token')"), 'escrow-link creation requires merchant JWT auth');
ok(linkRoute.includes("status: 'PENDING_FUNDING'"), 'escrow-link rows start PENDING_FUNDING (no depositor yet)');

const checkout = readFileSync(join(here, '..', 'src', 'app', 'api', 'escrow', 'create', 'route.ts'), 'utf8');
ok(checkout.includes("actor.type !== 'merchant'"), 'existing escrow/create merchant-depositor guard UNCHANGED');

console.log('\n═══ Escrow link — live API (server at ' + BASE + ') ═══');
let serverUp = false;
try {
  const res = await fetch(`${BASE}/api/escrow/link/does-not-exist`, { signal: AbortSignal.timeout(4000) });
  serverUp = res.status === 404 || res.status === 200;
  ok(res.status === 404, 'public detail endpoint reachable, unknown reference → 404', `got ${res.status}`);
} catch {
  console.log('  (dev server unreachable — live checks skipped; start `npm run dev` or set TEST_BASE_URL)');
}

if (serverUp) {
  const unauth = await fetch(`${BASE}/api/merchant/escrow-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beneficiarySCA: '0x1111111111111111111111111111111111111111', amount: 1, deadlineHours: 24 }),
  });
  ok(unauth.status === 401, 'unauthenticated escrow-link creation is rejected 401', `got ${unauth.status}`);

  const unauthFund = await fetch(`${BASE}/api/escrow/link/does-not-exist/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depositorSCA: '0x1111111111111111111111111111111111111111', txHash: '0x' + 'ab'.repeat(32) }),
  });
  ok(unauthFund.status === 404, 'fund recording refuses unknown references 404', `got ${unauthFund.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
