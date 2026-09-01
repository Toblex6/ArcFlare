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

console.log('═══ Escrow — beneficiary end-to-end (Phase 1-4) static proofs ═══');

// Phase 1: creation hardening
ok(checkout.includes('isAddress(beneficiarySCA)'), 'escrow/create validates beneficiarySCA is a real 0x address');
ok(checkout.includes('depositor and beneficiary must be different'), 'escrow/create blocks self-escrow (depositor == beneficiary)');
ok(checkout.includes('resolveBeneficiary') && checkout.includes('beneficiaryKind: beneficiary.kind'),
  'escrow/create classifies the beneficiary at creation and stores beneficiaryKind');
ok(checkout.includes('beneficiaryConfirmUrl'), 'escrow/create returns the beneficiary confirm link');

// Phase 2: Incoming list + notification
const listRoute = readFileSync(join(here, '..', 'src', 'app', 'api', 'escrow', 'list', 'route.ts'), 'utf8');
ok(listRoute.includes('role === \'beneficiary\''), 'escrow list supports ?role=beneficiary (incoming view)');
ok(listRoute.includes('getCallerControlledAddresses'), 'incoming list uses getCallerControlledAddresses (same trust set as release)');
const notifyLib = readFileSync(join(here, '..', 'src', 'lib', 'escrow', 'notifyBeneficiary.ts'), 'utf8');
ok(notifyLib.includes('beneficiaryNotifiedAt'), 'beneficiary notification is idempotent via beneficiaryNotifiedAt');
ok(notifyLib.includes('sendTelegramMessage'), 'consumer beneficiaries get a Telegram DM when a telegramUserId exists');

// Phase 4: external-EOA confirm — verify route never trusts bare claims
const confirmRoute = readFileSync(join(here, '..', 'src', 'app', 'api', 'escrow', '[reference]', 'beneficiary-confirm', 'route.ts'), 'utf8');
ok(confirmRoute.includes('getTransactionReliable') && confirmRoute.includes('extractSelector'), 'beneficiary-confirm fetches the raw tx and extracts the calldata selector');
ok(confirmRoute.includes('tx.from.toLowerCase() !== callerSCA.toLowerCase()'), 'beneficiary-confirm requires the tx sender to be the beneficiary');
ok(confirmRoute.includes('tx.to') && confirmRoute.includes('ESCROW_CONTRACT.toLowerCase()'), 'beneficiary-confirm requires the tx to target the escrow contract');
ok(confirmRoute.includes('escrowSelectors.confirmDelivery'), 'beneficiary-confirm requires the confirmDelivery function selector');
ok(confirmRoute.includes('decodeAbiParameters') && confirmRoute.includes('DIFFERENT escrow id'), 'beneficiary-confirm decodes the bytes32 arg and matches it to THIS escrow id');
ok(confirmRoute.includes('getReceiptReliable') && confirmRoute.includes('receipt.status !== \'success\''), 'beneficiary-confirm verifies the receipt is successful');
ok(confirmRoute.includes('readContractReliable') && confirmRoute.includes('getEscrow'),
  'beneficiary-confirm RE-READS authoritative getEscrow state and mirrors it (never receipt-success alone)');
ok(confirmRoute.includes('if (!beneficiaryConfirmed)'), 'beneficiary-confirm fails closed if on-chain state shows no confirmation');
ok(confirmRoute.includes("bothConfirmed ? 'RELEASED' : 'ACTIVE'"), 'beneficiary-confirm mirrors one-sided vs auto-released state from the contract');
ok(!confirmRoute.includes('createContractExecutionTransaction') && !confirmRoute.includes('transferUsdc') && !confirmRoute.includes('initiateDeveloperControlledWalletsClient'),
  'beneficiary-confirm never moves funds via Circle (verification-only)');

// Phase 4: public confirm page
const confirmPage = readFileSync(join(here, '..', 'src', 'app', 'escrow-confirm', '[reference]', 'page.tsx'), 'utf8');
ok(confirmPage.includes("functionName: 'confirmDelivery'"), 'confirm page signs confirmDelivery from the beneficiary\u2019s own wallet');
ok(confirmPage.includes('isBeneficiary') && confirmPage.includes('beneficiarySCA.toLowerCase() === address.toLowerCase()'),
  'confirm page blocks non-beneficiary wallets');
ok(confirmPage.includes('/beneficiary-confirm'), 'confirm page records via the public beneficiary-confirm route (server re-verifies on-chain)');
ok(!confirmPage.includes('developer-controlled-wallets') && !confirmPage.includes('CIRCLE_API_KEY'), 'confirm page has NO Circle SDK / custodial path');

// Phase 4: link route extension returns confirm state
const linkDetail = readFileSync(join(here, '..', 'src', 'app', 'api', 'escrow', 'link', '[reference]', 'route.ts'), 'utf8');
ok(linkDetail.includes('beneficiaryConfirmed') && linkDetail.includes('depositorConfirmed'), 'public link detail returns on-chain confirm flags');
ok(linkDetail.includes('contractEscrowId') && linkDetail.includes('confirmUrl'), 'public link detail returns contractEscrowId + confirmUrl');

// Phase 5 invariant applied to release too: never flip from body+receipt alone
const releaseRoute = readFileSync(join(here, '..', 'src', 'app', 'api', 'escrow', 'release', 'route.ts'), 'utf8');
ok(releaseRoute.includes('readContractReliable') && releaseRoute.includes('getEscrow'),
  'escrow/release re-reads authoritative on-chain state after confirm (never body+receipt alone)');
ok(releaseRoute.includes('Could not read the on-chain escrow state'), 'escrow/release fails closed when the state read is unavailable');

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
