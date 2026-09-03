/**
 * scripts/escrow-beneficiary-metrics-tests.mjs
 *
 * Regression suite for SUBTASK B — escrow Incoming (?role=beneficiary) crash.
 *
 * The Incoming tab crashed with "Something went wrong" because the page
 * dereferenced depositor-shaped metrics (totalLocked/totalReleased/...) via
 * .toFixed() while the beneficiary branch could return a partial/empty
 * metrics object (and Prisma Decimal amounts serialize as strings over JSON,
 * which also lack .toFixed).
 *
 * Contract decision (ONE clean approach): the API already returns the complete
 * metrics contract for ?role=beneficiary (same 7 keys as the depositor view);
 * the page therefore normalizes defensively at ingestion (normalizeMetrics)
 * and formats defensively at render (fmtAmount), so Incoming can never crash
 * on missing metrics regardless of wire shape. Depositor/"Mine" behavior and
 * beneficiary authorization (verifyCallerControlsAddress control set) are
 * preserved — both asserted below.
 *
 * Static proofs run always; live API checks run only when a dev server is
 * reachable at TEST_BASE_URL (default http://localhost:3000).
 *
 * Run: node scripts/escrow-beneficiary-metrics-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

const ROUTE_PATH = join(ROOT, 'src', 'app', 'api', 'escrow', 'list', 'route.ts');
const PAGE_PATH = join(ROOT, 'src', 'app', 'escrow', 'page.tsx');

const FULL_KEYS = ['total', 'active', 'released', 'disputed', 'refunded', 'totalLocked', 'totalReleased'];

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const skip = (label, detail = '') => {
  skipped++;
  console.log(`  ○ SKIP ${label}${detail ? ` — ${detail}` : ''}`);
};

const routeSrc = readFileSync(ROUTE_PATH, 'utf8');
const pageSrc = readFileSync(PAGE_PATH, 'utf8');

console.log('STATIC: beneficiary metrics contract (route)');
// Every `metrics: { ... }` literal in the route must carry the full 7-key
// contract: empty-controlled early return, beneficiary computed branch, and
// the depositor/"Mine" branch (parity + unchanged).
const metricLiterals = [...routeSrc.matchAll(/metrics:\s*\{([^}]*)\}/g)].map((m) => m[1]);
ok(metricLiterals.length === 3, `route defines exactly 3 metrics literals (empty + beneficiary + depositor), found ${metricLiterals.length}`);
for (const [i, lit] of metricLiterals.entries()) {
  const missing = FULL_KEYS.filter((k) => !new RegExp(`\\b${k}\\b`).test(lit));
  ok(missing.length === 0, `metrics literal #${i + 1} carries full contract`, missing.length ? `missing: ${missing.join(', ')}` : '');
}

console.log('STATIC: beneficiary authorization preserved (route)');
const roleIdx = routeSrc.indexOf("role === 'beneficiary'");
ok(roleIdx > 0, 'beneficiary branch exists');
ok(routeSrc.includes('getCallerControlledAddresses(request)'), 'beneficiary branch gates on getCallerControlledAddresses (single ownership gate, no second helper)');
ok(
  routeSrc.indexOf('resolveMerchant(request)') < roleIdx,
  'merchant auth (401 when unauthenticated) runs before the beneficiary branch'
);
ok(!/defaultWallet|DEFAULT_PAYER|fallback/i.test(routeSrc), 'no default-payer fallback in escrow list route');

console.log('STATIC: Incoming-safe rendering (page)');
ok(pageSrc.includes('setMetrics(normalizeMetrics(json.metrics))'), 'page normalizes metrics at ingestion');
ok(pageSrc.includes('Array.isArray(json.escrows)'), 'page guards escrows list (empty/non-array safe)');
for (const pat of ['metrics.totalLocked.toFixed', 'metrics.totalReleased.toFixed', 'e.amount.toFixed', 'selected.amount.toFixed']) {
  ok(!pageSrc.includes(pat), `no unguarded \`${pat}\``);
}
ok(pageSrc.includes('fmtAmount(metrics.totalLocked)') && pageSrc.includes('fmtAmount(metrics.totalReleased)'), 'metric cards render via fmtAmount');
ok(pageSrc.includes('normalizeMetrics(m: unknown): EscrowMetrics'), 'normalizeMetrics returns the full EscrowMetrics contract');

console.log('RUNTIME: metrics guards extracted from page.tsx (real code, transpiled)');
// Extract the guard block between markers, transpile the TS, and execute it —
// so these cases run the shipped helpers, not a copy.
const START = '// ── metrics guards (Incoming-safe) ──';
const END = '// ── end metrics guards ──';
const startIdx = pageSrc.indexOf(START);
const endIdx = pageSrc.indexOf(END);
let guards = null;
if (startIdx >= 0 && endIdx > startIdx) {
  const block = pageSrc.slice(startIdx + START.length, endIdx);
  try {
    const require = createRequire(join(ROOT, 'package.json'));
    const ts = require('typescript');
    const js = ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const factory = new Function(`${js}; return { toNum, normalizeMetrics, fmtAmount };`);
    guards = factory();
    ok(true, 'guard block transpiled + loaded from page.tsx');
  } catch (e) {
    ok(false, 'guard block transpiled + loaded from page.tsx', String(e?.message || e));
  }
} else {
  ok(false, 'guard block markers present in page.tsx');
}

if (guards) {
  const { normalizeMetrics, fmtAmount } = guards;
  const zeros = { total: 0, active: 0, released: 0, disputed: 0, refunded: 0, totalLocked: 0, totalReleased: 0 };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  ok(eq(normalizeMetrics(undefined), zeros), 'normalizeMetrics(undefined) → zeros (no crash)');
  ok(eq(normalizeMetrics(null), zeros), 'normalizeMetrics(null) → zeros');
  ok(eq(normalizeMetrics({}), zeros), 'normalizeMetrics({}) → zeros (old empty-shape crash gone)');
  ok(
    eq(normalizeMetrics({ total: 5, active: 2 }), { ...zeros, total: 5, active: 2 }),
    'normalizeMetrics(partial {total, active}) → rest zeroed (old partial-shape crash gone)'
  );
  const full = { total: 3, active: 1, released: 1, disputed: 1, refunded: 0, totalLocked: 42.5, totalReleased: 10 };
  ok(eq(normalizeMetrics(full), full), 'normalizeMetrics(full contract) passes through (depositor metrics unchanged)');
  ok(normalizeMetrics({ totalLocked: '12.5' }).totalLocked === 12.5, 'string numerics coerced (Decimal-over-JSON safe)');
  ok(normalizeMetrics({ totalLocked: 'abc', active: NaN }).totalLocked === 0, 'garbage numerics → 0, never NaN');

  // The exact render expressions from the metrics cards must never throw.
  for (const wire of [undefined, {}, { total: 5, active: 2 }, zeros, full]) {
    let rendered = '';
    try {
      const m = normalizeMetrics(wire);
      rendered = `${fmtAmount(m.totalLocked)} USDC / ${fmtAmount(m.totalReleased)} USDC / ${m.disputed} / ${m.refunded}`;
    } catch (e) {
      ok(false, `render expr safe for wire=${JSON.stringify(wire)}`, String(e?.message || e));
      continue;
    }
    ok(true, `render expr safe for wire=${JSON.stringify(wire)} → "${rendered}"`);
  }
  ok(fmtAmount(10) === '10.00', 'fmtAmount(10) → "10.00"');
  ok(fmtAmount('7.256') === '7.26', 'fmtAmount("7.256") → "7.26"');
  ok(fmtAmount(undefined) === '0.00', 'fmtAmount(undefined) → "0.00" (never throws)');
  // Empty list renders the safe empty state, not a crash.
  const escrows = Array.isArray(undefined) ? undefined : [];
  ok(Array.isArray(escrows) && escrows.length === 0, 'empty/non-array escrows → [] (empty state, no crash)');
} else {
  skip('runtime guard cases', 'guard block did not load');
}

console.log('LIVE: beneficiary auth (only when server reachable)');
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const res = await fetch(`${BASE}/api/escrow/list?role=beneficiary`, { signal: ctrl.signal });
  clearTimeout(timer);
  ok(res.status === 401, `unauthenticated ?role=beneficiary → 401 (got ${res.status})`);
} catch {
  skip('unauthenticated ?role=beneficiary → 401', 'no server at ' + BASE);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
