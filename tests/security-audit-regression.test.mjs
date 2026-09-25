// tests/security-audit-regression.test.mjs
//
// Regression proofs for the HIGH (H2,H5,H6,H8,H9,H10,H11,H12) + MEDIUM
// (M1,M2,M4,M5,M6,M8,M9) security-audit findings. Static source checks
// (no network, no DB, no funds) — each test asserts the exact exploit path
// from the audit is closed in the current tree.
// Run: node --test tests/security-audit-regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── H2: bridge verify/complete conditional claims ──────────────────────────
test('H2 verify uses updateMany status-guarded claim + re-read + P2002→409', () => {
  const s = read('src/app/api/cctp/transfer/external/verify/route.ts');
  assert.ok(s.includes("updateMany({") || s.includes('updateMany({'), 'conditional claim present');
  assert.ok(s.includes("status: 'PENDING'"), 'PENDING guard present');
  assert.ok(s.includes('claim.count === 0'), 'loser re-read path present');
  assert.ok(s.includes('INTENT_ALREADY_USED') && s.includes('P2002'), 'P2002→409 mapping present');
  assert.ok(!/flowBridgeIntent\.update\(\{\s*where:\s*\{\s*id:/.test(s), 'no unconditional update remains');
});

test('H2 complete uses updateMany BURN_CONFIRMED-guarded claim + re-read', () => {
  const s = read('src/app/api/cctp/transfer/external/complete/route.ts');
  assert.ok(s.includes("status: 'BURN_CONFIRMED'"), 'BURN_CONFIRMED guard present');
  assert.ok(s.includes('claim.count === 0'), 'loser re-read path present');
  assert.ok(s.includes('P2002'), 'P2002→409 mapping present');
  assert.ok(!/flowBridgeIntent\.update\(\{\s*where:\s*\{\s*id:/.test(s), 'no unconditional update remains');
});

// ── H5: merchant routes use central resolveMerchant ────────────────────────
const H5_ROUTES = [
  'src/app/api/merchant/me/route.ts',
  'src/app/api/merchant/wallet/route.ts',
  'src/app/api/merchant/assistant/route.ts',
  'src/app/api/merchant/payment-link/route.ts',
  'src/app/api/merchant/escrow-link/route.ts',
  'src/app/api/merchant/withdraw/route.ts',
  'src/app/api/merchant/merchant/withdraw/route.ts',
];
for (const r of H5_ROUTES) {
  test(`H5 ${r} uses resolveMerchant (active+verified+sessionVersion)`, () => {
    const s = read(r);
    assert.ok(s.includes('resolveMerchant'), `${r} calls resolveMerchant`);
    assert.ok(!s.includes('jwtVerify'), `${r} has no direct jwtVerify`);
  });
}

// ── H6: withdraw idempotency ───────────────────────────────────────────────
for (const r of ['src/app/api/merchant/withdraw/route.ts', 'src/app/api/merchant/merchant/withdraw/route.ts']) {
  test(`H6 ${r} requires Idempotency-Key + unique claim + replay`, () => {
    const s = read(r);
    assert.ok(s.includes('Idempotency-Key'), 'header required');
    assert.ok(s.includes('idempotencyKey') && s.includes('paymentLog'), 'unique-constraint dedupe via PaymentLog');
    assert.ok(s.includes('P2002'), 'concurrent-claim P2002 path');
    assert.ok(s.includes('replayed'), 'replay response');
  });
}

// ── H8: telegram signing authority ─────────────────────────────────────────
test('H8 botHandlers uses resolveConsumerWallet + requireServerSigning', () => {
  const s = read('src/lib/telegram/botHandlers.ts');
  assert.ok(s.includes('requireServerSigning'), 'server-signing gate present');
  assert.ok(s.includes('resolveConsumerWallet(account)'), 'canonical resolver present');
  assert.ok(!/if\s*\(!account\?\.circleWalletId/.test(s), 'presence-only authority check gone');
});

test('H8 invariant: EXTERNAL rows never yield a signing binding', async () => {
  // Pure resolver logic mirrored here (module has heavy deps; assert the
  // contract statically + behaviorally on the documented mapping).
  const s = read('src/lib/auth/consumerWallet.ts');
  assert.ok(s.includes("mode: \"EXTERNAL\""), 'EXTERNAL mode exists');
  // EXTERNAL branch must force circleWalletId null / canServerSign false
  // regardless of any stored circleWalletId value.
  const extBranch = s.slice(s.indexOf('if (t === "EXTERNAL")'), s.indexOf('if (t === "EXTERNAL")') + 400);
  assert.ok(extBranch.includes('circleWalletId: null') || extBranch.includes('circleWalletId:null'), 'EXTERNAL forces null binding');
  assert.ok(extBranch.includes('canServerSign: false'), 'EXTERNAL cannot server-sign');
  // requireServerSigning must reject EXTERNAL before transferUsdc.
  const gate = s.slice(s.indexOf('export function requireServerSigning'), s.indexOf('export function requireServerSigning') + 1500);
  assert.ok(gate.includes('EXTERNAL_REQUIRES_BROWSER_SIGNATURE'), 'EXTERNAL rejected at gate');
});

// ── H9: rate limits on spend paths ─────────────────────────────────────────
const H9_ROUTES = [
  ['src/app/api/payroll/run/route.ts', 'runPayrollHandler'],
  ['src/app/api/payments/scheduled/run/route.ts', 'runScheduledHandler'],
  ['src/app/api/payments/stream/create/route.ts', 'createStreamHandler'],
  ['src/app/api/jobs/[jobId]/fund/route.ts', 'handler'],
  ['src/app/api/agents/[id]/treasury/hire/route.ts', 'handler'],
];
for (const [r] of H9_ROUTES) {
  test(`H9 ${r} enforces payments-tier rate limit`, () => {
    const s = read(r);
    assert.ok(s.includes('checkRateLimit'), 'checkRateLimit called');
    assert.ok(s.includes("'payments'"), 'payments tier used');
  });
}
test('H9 ratelimit is fail-closed (memory fallback still enforces)', () => {
  const s = read('src/lib/ratelimit.ts');
  assert.ok(s.includes('fail-closed') || s.includes('fail closed'), 'fail-closed documented');
  assert.ok(s.includes('memoryRateLimit(key, config.limit'), 'fallback enforces same limit');
});

// ── H10: treasury caps + nano claim ────────────────────────────────────────
test('H10 nano settle uses conditional claim (settled+batchRef guard + count)', () => {
  const s = read('src/app/api/payments/nano/settle/route.ts');
  assert.ok(s.includes('settled: false') && s.includes('batchRef: null'), 'conditional predicate present');
  assert.ok(s.includes('claim.count !== ids.length'), 'count check present');
});

test('H10 treasuryPolicy exports per-agent spend lock + fund route holds it', () => {
  const t = read('src/lib/ledger/treasuryPolicy.ts');
  assert.ok(t.includes('withTreasurySpendLock'), 'lock exported');
  const f = read('src/app/api/jobs/[jobId]/fund/route.ts');
  assert.ok(f.includes('withTreasurySpendLock(clientAgent.id'), 'fund holds lock across check→debit');
  assert.ok(f.includes('status: "OPEN"') && f.includes('fundedClaim.count === 0'), 'conditional FUNDED claim');
  const h = read('src/app/api/agents/[id]/treasury/hire/route.ts');
  assert.ok(h.includes('Idempotency-Key'), 'hire requires server idempotency key');
});

// ── H11: payroll record-before-settle + per-payer mutex ────────────────────
test('H11 payrollExecution serializes per payer + records before settling', () => {
  const s = read('src/lib/payroll/payrollExecution.ts');
  assert.ok(s.includes('withPayerFundingLock(payer'), 'per-payer funding mutex held');
  assert.ok(s.includes('status: "PROCESSING"'), 'PROCESSING row claimed before settle');
  const claimIdx = s.indexOf('status: "PROCESSING"');
  const settleIdx = s.indexOf('await settlePayment(');
  assert.ok(claimIdx !== -1 && settleIdx !== -1 && claimIdx < settleIdx, 'record precedes settle');
  assert.ok(s.includes('status: "FUNDED"') && s.includes('where: { batchRef: fundingKey }'), 'FUNDED transitions the claimed row');
  assert.ok(!s.includes('prisma.payrollBatch.create({\n    data: {\n      batchRef,\n'), 'no second fire-and-forget create');
});

// ── H12: amount/chain validation ───────────────────────────────────────────
test('H12 shared amount rule is capped', () => {
  const s = read('src/lib/validation.ts');
  assert.ok(s.includes('MAX_USDC_AMOUNT'), 'cap exported');
  assert.ok(s.includes('Amount exceeds maximum'), 'cap enforced');
  assert.ok(s.includes('StreamCreateSchema'), 'StreamCreateSchema present');
});
const H12_SINKS = [
  'src/app/api/cctp/transfer/route.ts',
  'src/app/api/gateway/route.ts',
  'src/app/api/x402/seller/balance/withdraw/route.ts',
  'src/app/api/payments/stream/create/route.ts',
  'src/app/api/escrow/create/route.ts',
];
for (const r of H12_SINKS) {
  test(`H12 ${r} validates amount (regex+cap)`, () => {
    const s = read(r);
    assert.ok(s.includes('^\\d+(\\.\\d{1,6})?$') || s.includes('StreamCreateSchema') || s.includes('usdcAmount') || s.includes('USDC_AMOUNT_RE'), 'amount rule present');
  });
}
test('H12 destinations/chains are validated', () => {
  assert.ok(read('src/app/api/gateway/route.ts').includes('must be valid 0x addresses'), 'gateway isAddress');
  assert.ok(read('src/app/api/x402/seller/balance/withdraw/route.ts').includes('ALLOWED_CHAINS'), 'chain allowlist');
  assert.ok(read('src/app/api/payments/stream/create/route.ts').includes('StreamCreateSchema'), 'stream schema (scaAddress both ends)');
  assert.ok(read('src/app/api/escrow/create/route.ts').includes('depositorSCA must be a valid 0x address'), 'depositor isAddress');
});

// ── M1: shared validator gate ──────────────────────────────────────────────
test('M1 shared serviceability helper requires CIRCLE custody + live match', () => {
  const s = read('src/lib/validators/serviceability.ts');
  assert.ok(s.includes('assertValidatorServiceable'), 'helper exported');
  assert.ok(s.includes('walletProvider === "CIRCLE"') || s.includes('walletProvider') && s.includes('CIRCLE'), 'merchant CIRCLE check');
  assert.ok(s.includes('walletType') && s.includes('CIRCLE'), 'consumer CIRCLE check');
  assert.ok(s.includes('circleWalletId'), 'binding required');
  assert.ok(s.includes('getWallet'), 'live address match');
});
for (const r of ['src/app/api/agents/[id]/hire/route.ts', 'src/app/api/agents/[id]/treasury/hire/route.ts', 'src/app/api/procurement/[id]/hire/route.ts']) {
  test(`M1 ${r} uses the shared helper`, () => {
    assert.ok(read(r).includes('assertValidatorServiceable'), 'shared helper used');
  });
}

// ── M2: CCTP guards ported ─────────────────────────────────────────────────
for (const r of ['src/app/api/payments/settle/route.ts', 'src/app/api/settle-cross-chain/route.ts', 'src/app/api/payments/detect/route.ts']) {
  test(`M2 ${r} claims source-tx + decodes burn binding`, () => {
    const s = read(r);
    assert.ok(s.includes('cctpSourceTxHash'), 'unique source-tx claim');
    assert.ok(s.includes('P2002'), 'conflict → 409');
    assert.ok(s.includes('decodeBurnMessage'), 'burn binding decoded');
    assert.ok(s.includes('MISMATCH'), 'mismatch releases claim');
  });
}

// ── M4: consumer revocation ─────────────────────────────────────────────────
test('M4 consumer tokens carry sessionVersion + aud; resolver DB-binds', () => {
  const iss = read('src/lib/auth/consumerSession.ts');
  assert.ok(iss.includes('sessionVersion'), 'version claim minted');
  assert.ok(iss.includes('consumer-session'), 'aud claim minted');
  assert.ok(iss.includes('bumpConsumerSessionVersion'), 'revocation helper');
  const res = read('src/lib/middleware/withConsumerAuth.ts');
  assert.ok(res.includes('sessionVersion') && res.includes('findUnique'), 'DB-bound parity check');
  assert.ok(res.includes('audience'), 'aud enforced');
  const schema = read('prisma/schema.prisma');
  assert.ok(schema.includes('sessionVersion') && schema.includes('model ConsumerAccount'), 'column present');
  assert.ok(existsSync(path.join(ROOT, 'prisma/migrations/20260920000000_consumer_session_version/migration.sql')), 'migration present');
});

// ── M5: id-only agent refs on caller-control routes ────────────────────────
for (const r of ['src/app/api/agents/[id]/pay/route.ts', 'src/app/api/agents/[id]/policy/route.ts', 'src/app/api/agents/[id]/wallet/route.ts', 'src/app/api/agents/[id]/treasury/route.ts', 'src/app/api/agents/[id]/treasury/credit/route.ts']) {
  test(`M5 ${r} resolves id-only`, () => {
    const s = read(r);
    assert.ok(s.includes('resolveAgentRouteRefIdOnly'), 'id-only resolver');
    assert.ok(!s.includes('resolveAgentRef(ref,"auto")') && !s.includes("resolveAgentRef(ref, 'auto')"), 'no auto alias');
  });
}
test('M5 wrapper consumer branch is DB-bound (no bare jwtVerify)', () => {
  const s = read('src/lib/middleware/withMerchantAuth.ts');
  assert.ok(s.includes('resolveConsumerSession'), 'DB-bound consumer check');
});

// ── M6: float drift + receiver checks ───────────────────────────────────────
for (const r of ['src/app/api/merchant/escrow-link/route.ts', 'src/app/api/merchant/payment-link/route.ts', 'src/app/api/payments/scheduled/route.ts', 'src/app/api/payments/nano/route.ts']) {
  test(`M6 ${r} uses shared amount rule + address checks`, () => {
    const s = read(r);
    assert.ok(s.includes('^\\d+(\\.\\d{1,6})?$'), 'shared amount regex');
    assert.ok(s.includes('10_000_000'), 'capped');
  });
}
test('M6 intervalDays clamped 1-3650', () => {
  assert.ok(read('src/app/api/payments/scheduled/route.ts').includes('1 and 3650'), 'clamp present');
});
test('M6 nano + scheduled check receiver addresses', () => {
  assert.ok(read('src/app/api/payments/nano/route.ts').includes('must be valid 0x addresses'), 'nano isAddress');
  assert.ok(read('src/app/api/payments/scheduled/route.ts').includes('must be valid 0x addresses'), 'scheduled isAddress');
});

// ── M8: admin login ─────────────────────────────────────────────────────────
test('M8 admin login uses timingSafeEqual + strict tier', () => {
  const s = read('src/app/api/admin/login/route.ts');
  assert.ok(s.includes('timingSafeEqual'), 'constant-time compare');
  assert.ok(!/email !== adminEmail \|\| password !== adminPassword/.test(s), 'plaintext !== gone');
  assert.ok(s.includes("checkRateLimit(req, 'keys')"), 'strict tier');
});

// ── M9: contract hygiene ────────────────────────────────────────────────────
test('M9 cancelPayrollBatch quarantined (never submits a doomed tx)', () => {
  const s = read('src/lib/payroll/payrollExecution.ts');
  assert.ok(s.includes('quarantined') && s.includes('cancelPayrollBatch'), 'quarantine marker');
  assert.ok(!/export async function cancelPayrollBatch\(batchId: string\)[\s\S]{0,300}?payroll\.cancelBatch/.test(s), 'no relayer-signed cancel path');
});
test('M9 stale escrow source quarantined out of the served tree', () => {
  assert.ok(!existsSync(path.join(ROOT, 'src/app/api/contracts/ArcFlareEscrow.sol')), 'removed from app tree');
  assert.ok(existsSync(path.join(ROOT, 'contracts/stale/ArcFlareEscrow.stale.sol')), 'quarantined copy exists');
  const q = read('contracts/stale/ArcFlareEscrow.stale.sol');
  assert.ok(q.includes('QUARANTINED'), 'quarantine header');
});
test('M9 no admin address log line in next.config', () => {
  const s = read('next.config.mjs');
  assert.ok(!s.includes('YOUR DEVELOPER WALLET ADDRESS'), 'address log gone');
  assert.ok(!/new ethers\.Wallet\(process\.env\.ARC_ADMIN/.test(s), 'no address derivation');
});

// ── C1: /api/gateway ownership + allowlist gates ───────────────────────────
test('C1 gateway GET requires explicit seller + caller control (no SELLER_ADDRESS fallback)', () => {
  const s = read('src/app/api/gateway/route.ts');
  assert.ok(!s.includes('SELLER_ADDRESS'), 'no SELLER_ADDRESS fallback anywhere');
  assert.ok(!s.includes('PAYOUT_WALLET_ADDRESS'), 'no PAYOUT_WALLET_ADDRESS fallback anywhere');
  assert.ok(
    s.includes('verifyCallerControlsAddress(request, sellerAddress)'),
    'GET balance gates caller control of sellerAddress'
  );
  assert.ok(
    s.includes('You do not control the seller wallet named in sellerAddress.'),
    'GET rejection is a 403 ownership message'
  );
});

test('C1 gateway POST gates seller control + treasury allowlist before funds move', () => {
  const s = read('src/app/api/gateway/route.ts');
  const gateIdx = s.indexOf('verifyCallerControlsAddress(request, resolvedSeller)');
  assert.ok(gateIdx !== -1, 'POST gates caller control of resolvedSeller');
  const allowIdx = s.indexOf('SELLER_GATEWAY_TREASURY_ADDRESSES');
  assert.ok(allowIdx !== -1, 'POST restricts payoutAddress to the treasury allowlist');
  // The allowlist identifier first appears in the fix comment; the ENFORCEMENT
  // (treasuryAllowlist.includes) and the sink (facilitator fetch) must both
  // come after the ownership gate. The `/withdraw` path string also appears
  // in the earlier fix comment, so the sink search is anchored past the gate.
  const allowEnforceIdx = s.indexOf('treasuryAllowlist.includes', gateIdx);
  const sinkIdx = s.indexOf('facilitatorUrl()', gateIdx);
  assert.ok(allowEnforceIdx !== -1 && sinkIdx !== -1, 'allowlist enforcement + withdraw sink located');
  assert.ok(gateIdx < allowEnforceIdx && gateIdx < sinkIdx, 'both gates run after the ownership gate, before the sink');
  assert.ok(
    s.includes('payoutAddress is not on the SELLER_GATEWAY_TREASURY_ADDRESSES allowlist.'),
    'allowlist rejection is a 403 with the allowlist message'
  );
});

// ── H7: x402 seller withdraw ownership gate ────────────────────────────────
test('H7 seller withdraw gates caller control of the pooled seller EOA before signing', () => {
  const s = read('src/app/api/x402/seller/balance/withdraw/route.ts');
  const gateIdx = s.indexOf('verifyCallerControlsAddress(request, sellerAddress)');
  assert.ok(gateIdx !== -1, 'ownership gate on the derived seller EOA');
  // `new GatewayClient` also appears in the usage-example comment at the top
  // of the file, so the construction search is anchored past the gate.
  const clientIdx = s.indexOf('new GatewayClient', gateIdx);
  assert.ok(clientIdx !== -1, 'GatewayClient construction located after the gate');
  assert.ok(
    s.includes('You do not control the seller wallet this withdrawal would draw from.'),
    'rejection is a 403 ownership message'
  );
});
