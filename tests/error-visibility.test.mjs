// tests/error-visibility.test.mjs — silent-error regression tests (Phase 5).
//
// Previously, genuinely unexpected failures were swallowed and surfaced as
// misleading successes/401s with nothing in the logs: the app error boundary
// logged nowhere, admin-login 500s were silent, the withdrawal post-tx ledger
// update failed silently after funds moved, Circle webhook delivery failures
// and attestation-mark failures vanished, and agent deploy/recover RPC
// retries failed without a trace.
//
// Rule preserved throughout: EXPECTED 401/404/409/deliberate-503 responses
// stay silent (no noisy errors for bad credentials, missing rows, duplicate
// replays, or fail-closed gates). Only UNEXPECTED failures (DB errors,
// config errors, post-tx update failures, delivery failures, retry
// exhaustion signals) must be logged — without credentials, API keys, JWTs,
// secrets, or full request bodies.
//
// Scope: static/unit only — no DB, no network, no secrets.
// Run: npx tsx --test tests/error-visibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// Sensitive tokens that must NEVER appear inside a console.* log line.
const SECRET_PATTERNS = [
  'password',
  'apiKey',
  'CIRCLE_API_KEY',
  'CIRCLE_ENTITY_SECRET',
  'JWT_SECRET',
  'merchant_token',
  'consumer_token',
  'admin_token',
  'entitySecret',
];

function logLines(src) {
  return src.split('\n').filter((l) => /console\.(log|warn|error)/.test(l));
}

function assertNoSecrets(file, src) {
  for (const line of logLines(src)) {
    const lower = line.toLowerCase();
    for (const secret of SECRET_PATTERNS) {
      // 'apiKeyHint' is a masked display hint, not a secret — allow it.
      if (secret === 'apiKey' && lower.includes('apikeyhint')) continue;
      assert.ok(
        !lower.includes(secret.toLowerCase()),
        `${file} log line must not contain ${secret}: ${line.trim().slice(0, 120)}`
      );
    }
  }
}

// ── 1. App error boundary logs unexpected client failures ───────────────────
test('app error boundary logs the failure (message + digest only)', () => {
  const src = read('src/app/error.tsx');
  assert.ok(src.includes('useEffect'), 'error boundary must react to the error');
  assert.ok(src.includes('console.error'), 'error boundary must log via console.error');
  assert.ok(src.includes('digest'), 'log should carry the Next digest for correlation');
  assertNoSecrets('src/app/error.tsx', src);
});

// ── 2. Admin login: unexpected 500 logs, bad-credential 401 stays silent ────
test('admin login logs unexpected failures, keeps 401 silent', () => {
  const src = read('src/app/api/admin/login/route.ts');
  const catchBlock = src.slice(src.lastIndexOf('} catch'));
  assert.ok(catchBlock.includes('console.error'), 'admin login outer catch must log');
  const unauthorized = src.slice(src.indexOf('Invalid credentials'), src.indexOf('Invalid credentials') + 120);
  assert.ok(!unauthorized.includes('console.'), 'bad-credential 401 must stay silent');
  assertNoSecrets('src/app/api/admin/login/route.ts', src);
});

// ── 3. Consumer session: DB failure visible, invalid session silent ─────────
test('consumer session DB failure is logged, invalid session stays silent', () => {
  const auth = read('src/lib/middleware/withConsumerAuth.ts');
  assert.ok(
    auth.includes("console.error('[consumer/session] account lookup failed:'"),
    'withConsumerAuth DB catch must log'
  );
  const route = read('src/app/api/consumer/session/route.ts');
  assert.ok(
    route.includes('[consumer/session] bridge link block failed:'),
    'bridge-link wrapper catch must warn'
  );
  assert.ok(
    route.includes('[consumer/session] Path-B invariant pre-check failed:'),
    'Path-B invariant catch must warn'
  );
  // The GET session-check 401 for a bad/expired token stays silent by design.
  const get401 = route.slice(route.indexOf('Invalid or expired session') - 200, route.indexOf('Invalid or expired session'));
  assert.ok(!get401.includes('console.'), 'expected session 401 must stay silent');
  assertNoSecrets('src/lib/middleware/withConsumerAuth.ts', auth);
  assertNoSecrets('src/app/api/consumer/session/route.ts', route);
});

// ── 4. Merchant payment links: unexpected failures logged, 401 silent ───────
test('payment-link failures are visible, unauthenticated stays 401-silent', () => {
  const src = read('src/app/api/merchant/payment-link/route.ts');
  assert.ok(
    src.includes('[merchant/payment-link] USDC token resolve failed:'),
    'token-resolve 500 must log its cause'
  );
  assert.ok(
    src.includes('[merchant/payment-link] GET failed:'),
    'GET unexpected failure must log + 500, not masquerade as 401'
  );
  assert.ok(
    src.includes("error: 'Not authenticated.' }, { status: 401 }"),
    'unauthenticated callers must still get a silent 401'
  );
  assertNoSecrets('src/app/api/merchant/payment-link/route.ts', src);
});

// ── 5. Withdrawal: post-tx ledger failure is loud, response stays honest ────
test('withdrawal post-tx ledger failure is logged with txHash', () => {
  const src = read('src/app/api/merchant/withdraw/route.ts');
  assert.ok(
    src.includes('POST-TX LEDGER UPDATE FAILED'),
    'post-on-chain DB failure must be logged loudly'
  );
  assert.ok(
    src.includes('txHash=${txHash}'),
    'log must carry the txHash for reconciliation'
  );
  assert.ok(!src.includes('.catch(() => {})'), 'no silent catch may remain in the withdraw route');
  assertNoSecrets('src/app/api/merchant/withdraw/route.ts', src);
});

// ── 6. Circle webhook: delivery + mark failures visible, ACK-200 kept ───────
test('webhook delivery/mark failures are logged, ACK-200 preserved', () => {
  const src = read('src/app/api/webhooks/circle/route.ts');
  assert.ok(
    src.includes('merchant callback delivery failed for'),
    'merchant callback swallow must warn'
  );
  assert.ok(
    src.includes('auto-settle callback delivery failed for'),
    'auto-settle callback swallow must warn'
  );
  assert.ok(
    src.includes('ATTESTATION_FAILED mark failed for'),
    'failure-mark swallow must log loudly'
  );
  assert.ok(
    src.includes('status: 200'),
    'webhook acknowledgement behavior (200) must be preserved'
  );
  assertNoSecrets('src/app/api/webhooks/circle/route.ts', src);
});

// ── 7. Agent deploy/recover retries warn per attempt ────────────────────────
test('agent deploy/recover RPC retries warn per attempt', () => {
  const deploy = read('src/app/api/agent/deploy/route.ts');
  assert.ok(
    deploy.includes('[agent/deploy] tokenId log scan attempt'),
    'deploy log-scan retry must warn per attempt'
  );
  const recover = read('src/app/api/agent/deploy/recover/route.ts');
  assert.ok(
    recover.includes('[agent/deploy/recover] receipt fetch attempt'),
    'recover receipt retry must warn per attempt'
  );
  assert.ok(
    recover.includes('[agent/deploy/recover] wallet-set proof attempt'),
    'recover wallet-set retry must warn per attempt'
  );
  assertNoSecrets('src/app/api/agent/deploy/route.ts', deploy);
  assertNoSecrets('src/app/api/agent/deploy/recover/route.ts', recover);
});

// ── 8. Login timing diagnostics carry no sensitive data ─────────────────────
test('merchant login/me timing logs carry durations only', () => {
  const login = read('src/app/api/merchant/login/route.ts');
  assert.ok(login.includes('[merchant/login] req='), 'login must log a correlated timing line');
  assertNoSecrets('src/app/api/merchant/login/route.ts', login);
  const me = read('src/app/api/merchant/me/route.ts');
  assert.ok(me.includes('[merchant/me] totalMs='), 'me must log its timing line');
  assertNoSecrets('src/app/api/merchant/me/route.ts', me);
});

// ── 9. Request-id helper: passthrough, mint, reject ─────────────────────────
test('getRequestId passes through valid ids and mints otherwise', async () => {
  const { getRequestId } = await import('../src/lib/requestId.ts');
  const hdr = (v) => ({ headers: { get: () => v } });
  assert.equal(getRequestId(hdr('abc-123_XY:9')), 'abc-123_XY:9');
  const minted = getRequestId(hdr(null));
  assert.ok(typeof minted === 'string' && minted.length >= 4, 'must mint an id when absent');
  assert.notEqual(getRequestId(hdr(null)), getRequestId(hdr(null)), 'minted ids vary');
  const evil = getRequestId(hdr('has space; DROP'));
  assert.ok(!evil.includes(' '), 'malformed incoming ids must be replaced, not echoed');
});
