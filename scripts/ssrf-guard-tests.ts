// scripts/ssrf-guard-tests.ts
//
// H4 — SSRF guard for marketplace targetUrl. Two layers:
//   1. unit tests on assertSafeTargetUrl (fast, deterministic, offline-safe)
//   2. live route tests: listing creation rejects internal/metadata/non-https
//      targetUrls; legit https still works; PATCH targetUrl update rejects
//      the same set.
//
// Run: npx tsx scripts/ssrf-guard-tests.ts   (dev server on 127.0.0.1:3000)

import { assertSafeTargetUrl } from '../src/lib/security/ssrfGuard';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean, detail?: string) {
  checks++;
  if (cond) console.log(`  ok ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/payments/verify/__probe__`);
      if (res.status === 404) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function unitTests() {
  console.log('[unit] assertSafeTargetUrl');
  const cases: Array<[string, boolean, string]> = [
    // [url, expectOk, label]
    ['https://example.com/path', true, 'legit https passes'],
    ['https://example.com:8443/v1', true, 'legit https with port passes'],
    ['https://nonexistent-ssrf-probe.invalid/', false, 'unresolvable hostname rejected (fail-closed)'],
    ['http://example.com/', false, 'http is rejected (https-only)'],
    ['ftp://example.com/', false, 'ftp is rejected'],
    ['http://169.254.169.254/', false, 'cloud metadata IPv4 blocked'],
    ['http://127.0.0.1/', false, 'loopback IPv4 blocked'],
    ['http://localhost/', false, 'localhost hostname blocked'],
    ['http://localhost:3000/', false, 'localhost with port blocked'],
    ['http://myapp.localhost/', false, '*.localhost hostname blocked'],
    ['http://intranet.local/', false, '*.local hostname blocked'],
    ['http://10.0.0.1/', false, 'private 10/8 blocked'],
    ['http://172.16.5.5/', false, 'private 172.16/12 blocked'],
    ['http://192.168.1.10/', false, 'private 192.168/16 blocked'],
    ['http://100.64.0.1/', false, 'CGNAT 100.64/10 blocked'],
    ['http://[::1]/', false, 'IPv6 loopback blocked'],
    ['https://127.0.0.1/', false, 'https loopback IP still blocked'],
    ['https://[::ffff:127.0.0.1]/', false, 'IPv4-mapped loopback blocked'],
    ['https://[fc00::1]/', false, 'IPv6 ULA blocked'],
  ];
  for (const [url, expectOk, label] of cases) {
    const res = await assertSafeTargetUrl(url);
    ok(label, res.ok === expectOk, `got ok=${res.ok} reason=${res.reason}`);
  }
}

async function liveTests() {
  const merchant = await prisma.merchant.findFirst({
    where: { businessName: 'acne corp', verified: true, active: true },
  });
  if (!merchant?.apiKey) {
    console.log('  SKIP live tests — no merchant with apiKey in DB');
    return;
  }
  const headers = { 'x-api-key': merchant.apiKey, 'content-type': 'application/json' };

  console.log('[live] create listing targetUrl validation');

  const badUrls = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:3000/',
    'http://localhost/',
    'http://10.0.0.1/',
    'http://192.168.0.1/',
    'http://172.16.0.1/',
    'http://[::1]/',
    'ftp://example.com/',
    'http://example.com/',
  ];
  for (const badUrl of badUrls) {
    const res = await fetch(`${BASE}/api/x402/marketplace`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ssrf probe', pricePerRequest: '$0.01', targetUrl: badUrl }),
    });
    ok(`create rejects ${badUrl}`, res.status === 400, `got ${res.status}`);
  }

  const goodUrl = 'https://example.com/api';
  const res = await fetch(`${BASE}/api/x402/marketplace`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `ssrf good ${Date.now()}`, pricePerRequest: '$0.01', targetUrl: goodUrl }),
  });
  const body = await res.json().catch(() => ({}));
  ok('create accepts legit https targetUrl', res.status === 201, `got ${res.status} ${body.error ?? ''}`);
  const slug = body?.listing?.slug;
  if (slug) {
    const patchRes = await fetch(`${BASE}/api/x402/marketplace/${slug}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ targetUrl: 'http://127.0.0.1/' }),
    });
    ok('PATCH targetUrl rejects loopback', patchRes.status === 400, `got ${patchRes.status}`);
  }
}

async function main() {
  if (!(await waitForServer())) {
    console.log('FAIL dev server not reachable');
    process.exit(1);
  }
  await unitTests();
  await liveTests();
  console.log(`\nssrf-guard-tests: ${checks} checks, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ssrf-guard-tests crashed:', e);
  process.exit(1);
});