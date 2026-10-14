// tests/dashboard-truthfulness.test.mjs — Phase 6 regression tests.
//
// Covers: FlareHQ logo links home, no duplicate homepage nav, analytics
// truthfulness (per-currency buckets, unavailable data never zero-filled or
// fabricated), CCTP/webhook tracking honesty, and mainnet fail-closed gates.
//
// Scope: static/unit only — no DB, no network.
// Run: npx tsx --test tests/dashboard-truthfulness.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// ── 1. Logo links to the homepage ───────────────────────────────────────────
test('FlareHQ logos link to the homepage', () => {
  for (const f of [
    'src/components/DashboardSidebar.tsx',
    'src/components/ResponsiveSidebar.tsx',
    'src/app/stats/page.tsx',
  ]) {
    const src = read(f);
    assert.ok(
      src.includes('<Link href="/"'),
      `${f}: FlareHQ logo must link to the homepage`
    );
  }
});

// ── 2. No duplicate homepage nav ────────────────────────────────────────────
test('no duplicate homepage navigation item alongside the logo link', () => {
  const sidebar = read('src/components/DashboardSidebar.tsx');
  assert.ok(
    !sidebar.includes("{ label: 'Homepage', href: '/' }"),
    'DashboardSidebar must not carry a separate Homepage item now the logo links home'
  );
  // Homepage access still exists exactly once (the logo link).
  const logoLinks = (sidebar.match(/<Link href="\/"/g) ?? []).length;
  assert.equal(logoLinks, 1, 'homepage access must exist exactly once (the logo)');
});

// ── 3. Analytics truthful about currencies ──────────────────────────────────
test('public stats report per-currency buckets, never a mixed-unit sum as USDC', () => {
  const api = read('src/app/api/stats/public/route.ts');
  assert.ok(api.includes('volumeByCurrency'), 'stats API must return per-currency volume');
  assert.ok(api.includes('lockedByCurrency'), 'stats API must return per-currency locked');
  assert.ok(api.includes('releasedByCurrency'), 'stats API must return per-currency released');
  assert.ok(
    api.includes('NEVER summed') || api.includes('never summed') || api.includes('DEPRECATED mixed-unit'),
    'mixed-unit total must be documented as deprecated, not presented as clean'
  );
  const page = read('src/app/stats/page.tsx');
  assert.ok(
    page.includes('volumeByCurrency'),
    'stats UI must render the per-currency buckets'
  );
  assert.ok(
    !page.includes("'USDC Volume Settled'\n") || page.includes('EURC'),
    'stats UI must not present a mixed-unit figure as pure USDC'
  );
});

test('analytics still marks untracked CCTP/webhook data as unavailable', () => {
  const analytics = read('src/app/api/merchant/analytics/route.ts');
  assert.ok(analytics.includes('notTracked'), 'merchant analytics must surface notTracked');
  assert.ok(analytics.includes('cctpTransfers'), 'CCTP gap must stay disclosed');
  assert.ok(analytics.includes('webhookDeliveryLogs'), 'webhook gap must stay disclosed');
  const all = read('src/app/api/payments/all/route.ts');
  const allCode = all
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !allCode.includes('Math.random()'),
    'payments/all must not fabricate telemetry (no random nonces in code)'
  );
});

// ── 4. No false integration claims ──────────────────────────────────────────
test('stats page does not badge unavailable integrations as integrated', () => {
  const page = read('src/app/stats/page.tsx');
  const badgeBlock = page.slice(page.indexOf('Circle Products Integrated'), page.indexOf('Not badged'));
  assert.ok(!badgeBlock.includes("'Webhooks'"), 'Webhooks (delivery untracked) must not be badged integrated');
  assert.ok(!badgeBlock.includes("'Gateway Nanopayments'"), 'Gateway nanopayments (mainnet-disabled) must not be badged integrated');
  assert.ok(page.includes('Not badged:'), 'the page must honestly disclose what is NOT badged');
});

test('testnet contract addresses are never shown as mainnet contracts', () => {
  const page = read('src/app/stats/page.tsx');
  assert.ok(
    page.includes("arcName === 'Arc Testnet'"),
    'pinned testnet addresses must render only on the testnet view'
  );
  assert.ok(
    page.includes('never shown as'),
    'mainnet view must explain why no addresses are listed'
  );
});

// ── 5. CCTP tracking honesty (no fabricated persistence) ────────────────────
test('bridge status is honest about process-local tracking limits', () => {
  const route = read('src/app/api/cctp/transfer/status/route.ts');
  assert.ok(
    route.includes('server restarted'),
    'unknown-reference 404 must disclose the process-local tracking limit'
  );
  const lib = read('src/lib/cctp-v2.ts');
  assert.ok(
    lib.includes('process-local'),
    'cctp-v2 must document that live tracking does not survive restart'
  );
});

// ── 6. Mainnet fail-closed gates intact ─────────────────────────────────────
test('x402 Gateway stays disabled on mainnet (503)', () => {
  const gw = read('src/lib/x402-gateway.ts');
  assert.ok(gw.includes('mainnet'), 'gateway availability must branch on mainnet');
  assert.ok(
    gw.includes('503') || gw.includes('GatewayMainnetUnavailableError'),
    'mainnet gateway use must fail closed'
  );
  const pay = read('src/app/api/x402/pay/route.ts');
  assert.ok(pay.includes('503'), '/api/x402/pay must 503 when the gateway is unavailable');
});

test('ERC-8183 features stay fail-closed without a mainnet address', () => {
  const net = read('src/lib/config/network.ts');
  assert.ok(net.includes('erc8183Address: erc8183Raw ?? null'), 'mainnet ERC-8183 must stay null-when-unset');
  assert.ok(net.includes('Erc8183UnavailableError'), 'missing ERC-8183 must throw a typed error');
});

test('payroll/stream/relayer use the authoritative network RPC (no testnet pin)', () => {
  for (const f of [
    'src/lib/wallet/jobEscrowClient.ts',
    'src/lib/contracts/streamContract.ts',
  ]) {
    const src = read(f);
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    assert.ok(
      !code.includes('ARC_TESTNET_RPC_URL'),
      `${f} must not keep the misleading testnet-named RPC constant`
    );
    assert.ok(
      src.includes('getNetworkConfig().primaryRpc'),
      `${f} must resolve the RPC from the authoritative network config`
    );
  }
  const payroll = read('src/lib/payroll/payrollExecution.ts');
  assert.ok(
    payroll.includes('PAYROLL_CONTRACT_ADDRESS is not configured'),
    'payroll must fail closed without its contract address'
  );
});
