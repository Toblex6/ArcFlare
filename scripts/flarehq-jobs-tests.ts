// Pure/static FlareHQ Jobs tests. No DB, RPC, signing or funds.
import { readFileSync } from 'node:fs';
import { parseJobUnits, formatJobUnits, flareHQJobEscrowReference, flareHQJobEscrowId, FLAREHQ_JOB_STATUSES } from '../src/lib/jobs/flarehqJob';

let passed = 0; let failed = 0;
const ok = (name: string, condition: boolean) => { condition ? (passed++, console.log(`  ✅ ${name}`)) : (failed++, console.log(`  ❌ ${name}`)); };
const read = (p: string) => readFileSync(p, 'utf8');

console.log('[pure helpers]');
ok('1 USDC parses to 1e6', parseJobUnits('1') === 1_000_000n);
ok('six decimals preserved', parseJobUnits('1.000001') === 1_000_001n);
ok('format is canonical six decimals', formatJobUnits(1_000_001n) === '1.000001');
for (const bad of ['', '0', '-1', '1.0000001', 'abc', '10000001']) {
  let threw = false; try { parseJobUnits(bad); } catch { threw = true; }
  ok(`rejects budget ${JSON.stringify(bad)}`, threw);
}
ok('reference is deterministic', flareHQJobEscrowReference('abc') === 'flarehq-job-abc');
ok('escrow id is deterministic bytes32', /^0x[0-9a-f]{64}$/i.test(flareHQJobEscrowId('abc')) && flareHQJobEscrowId('abc') === flareHQJobEscrowId('abc'));
for (const status of ['OPEN', 'SELECTED', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'REFUNDED']) ok(`status includes ${status}`, (FLAREHQ_JOB_STATUSES as readonly string[]).includes(status));

console.log('[route and architecture wiring]');
const files = [
  'src/app/api/flarehq-jobs/route.ts',
  'src/app/api/flarehq-jobs/[id]/apply/route.ts',
  'src/app/api/flarehq-jobs/[id]/select/route.ts',
  'src/app/api/flarehq-jobs/[id]/fund/route.ts',
  'src/app/api/flarehq-jobs/[id]/submit/route.ts',
  'src/app/api/flarehq-jobs/[id]/approve/route.ts',
  'src/app/api/flarehq-jobs/[id]/release/route.ts',
  'src/app/api/flarehq-jobs/[id]/dispute/route.ts',
  'src/app/api/flarehq-jobs/[id]/refund/route.ts',
];
for (const file of files) {
  const source = read(file);
  ok(`${file} gates through escrowAddressOr503`, source.includes('escrowAddressOr503'));
  ok(`${file} never imports ERC-8183`, !/erc8183|agenticCommerceAbi/i.test(source));
  ok(`${file} never references ArcBounty/old job escrow`, !/ArcBounty|ArcFlareJobEscrow/.test(source));
}
const fund = read(files[3]);
const actions = read('src/lib/jobs/flarehqEscrowActions.ts');
const approve = read(files[5]);
const release = read(files[6]);
ok('fund uses createEscrow', fund.includes('createEscrow(bytes32,address,uint256,uint256,string)'));
ok('fund resolves exact client wallet', fund.includes('resolveExactJobWallet(job.clientAddress)'));
ok('no default payer fallback in action helper', !/\|\|\s*process\.env.*WALLET/i.test(actions) && !actions.includes('DEFAULT_PAYER'));
ok('all sensitive routes use the single ownership gate wrapper', files.filter((f) => f !== 'src/app/api/flarehq-jobs/[id]/route.ts').every((f) => read(f).includes('requireFlareHQJobActor')));
ok('client approval confirms delivery', approve.includes('confirmDelivery(bytes32)'));
ok('provider release confirms delivery', release.includes('confirmDelivery(bytes32)'));
ok('release requires both confirmations', release.includes('depositorConfirmed') && release.includes('beneficiaryConfirmed'));
ok('refund uses expiry-only contract operation', read(files[8]).includes('refundExpired(bytes32)'));
ok('dispute uses contract dispute', read(files[7]).includes('dispute(bytes32,string)'));
const page = read('src/app/flarehq-jobs/page.tsx');
ok('page labels product honestly', page.includes('FlareHQ Jobs') && page.includes('not ERC-8183'));
ok('page calls only FlareHQ Jobs APIs', page.includes('/api/flarehq-jobs') && !page.includes('/api/jobs'));

console.log(`\nflarehq-jobs-tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
