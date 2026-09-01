// scripts/http-auth-tests.mjs
// HTTP-level regression tests for the fail-closed auth + address-control
// fixes. Run against a local `next dev` server (no funds move, no onchain
// txs: every test below asserts an auth/control rejection or a session
// handshake, all of which happen BEFORE any Circle/onchain call).
//
// Usage: node scripts/http-auth-tests.mjs [baseUrl]

import { ethers } from 'ethers';

const BASE = process.argv[2] || 'http://localhost:3199';
// No inline fallback: the previous hardcoded default was a live ApiKey row and
// this file is committed to a public repo. Rotated 2026-08-20; read from env only.
const API_KEY = process.env.TEST_API_KEY;
if (!API_KEY) {
  console.error('TEST_API_KEY not set — put the service key in .env.local and run with it in env.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function j(res) {
  try { return await res.json(); } catch { return {}; }
}

// ── Test: consumer session challenge + signature handshake ────────────────
async function testConsumerSession() {
  console.log('\n[consumer/session]');
  const wallet = ethers.Wallet.createRandom();
  const forged = ethers.Wallet.createRandom();
  const cookieJar = new Map();

  const withCookies = (init) => {
    const headers = new Headers(init?.headers || {});
    for (const c of cookieJar.values()) headers.append('cookie', c);
    return new Request(init ? { ...init, headers } : { headers });
  };
  const cookieHeader = () =>
    [...cookieJar.values()].join('; ');

  const remember = (res) => {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      // Multiple cookies can arrive in one header, and Expires/Max-Age
      // values contain commas — extract name=value pairs via regex.
      for (const match of setCookie.matchAll(/([A-Za-z0-9_]+)=([^;,]*)/g)) {
        if (match[1] === 'consumer_connect_nonce' || match[1] === 'consumer_token') {
          cookieJar.set(match[1], `${match[1]}=${match[2]}`);
        }
      }
    }
  };

  // 1. Challenge issued for wallet A (its nonce cookie is stored in the jar)
  const ch = await fetch(`${BASE}/api/consumer/session?nonce=1&address=${wallet.address}`);
  remember(ch);
  const chData = await j(ch);
  ok('challenge issued', chData.success === true && typeof chData.message === 'string' && chData.message.length > 20, JSON.stringify(chData).slice(0, 120));

  // 2. Correct signature from A + nonce cookie → session established
  const sig = await wallet.signMessage(chData.message);
  const post = await fetch(`${BASE}/api/consumer/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ walletAddress: wallet.address, message: chData.message, signature: sig }),
  });
  const postData = await j(post);
  remember(post);
  ok('valid signature accepted + cookie set', postData.success === true && /consumer_token=/.test(post.headers.get('set-cookie') || ''), JSON.stringify(postData).slice(0, 120));

  // 3. Forged: challenge bound to B, signature from A, submitted as B → reject
  const chB = await fetch(`${BASE}/api/consumer/session?nonce=1&address=${forged.address}`);
  remember(chB);
  const chBData = await j(chB);
  const sigForB = await wallet.signMessage(chBData.message);
  const forgedPost = await fetch(`${BASE}/api/consumer/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ walletAddress: forged.address, message: chBData.message, signature: sigForB }),
  });
  const forgedData = await j(forgedPost);
  ok('signature mismatch rejected', forgedPost.status === 401 && forgedData.success === false, `${forgedPost.status} ${JSON.stringify(forgedData).slice(0, 120)}`);

  // 4. Garbage signature → reject
  const garbage = await fetch(`${BASE}/api/consumer/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ walletAddress: wallet.address, message: chData.message, signature: '0xdeadbeef' }),
  });
  ok('garbage signature rejected', garbage.status === 400 || garbage.status === 401, `status=${garbage.status}`);

  // 5. No cookie → GET reports no session
  const anon = await fetch(`${BASE}/api/consumer/session`);
  const anonData = await j(anon);
  ok('anonymous GET has no session', anonData.success === false || !anonData.account, JSON.stringify(anonData).slice(0, 120));

  // 6. Signed-in cookie persists session
  const me = await fetch(`${BASE}/api/consumer/session`, { headers: { Cookie: cookieHeader() } });
  const meData = await j(me);
  ok('session GET with cookie', meData.success === true && meData.account?.walletAddress?.toLowerCase() === wallet.address.toLowerCase(), JSON.stringify(meData).slice(0, 120));

  // 7. Apply with THIS wallet to a nonexistent job → control passes, job lookup → 404
  const applyRes = await fetch(`${BASE}/api/jobs/999999999/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: JSON.stringify({ applicantAddress: wallet.address, pitch: 'Automated auth test application with a sufficiently long pitch to be meaningful.' }),
  });
  const applyData = await j(applyRes);
  ok('apply to nonexistent job → 404', applyRes.status === 404, `status=${applyRes.status} ${JSON.stringify(applyData).slice(0, 160)}`);
}

// ── Test: initialize + settle require authentication ──────────────────────
async function testSettleOwnership() {
  console.log('\n[payments/initialize + settle]');
  const init = await fetch(`${BASE}/api/payments/initialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '0.01', currency: 'USDC', merchant: 'AuthTestMerchant', direction: 'request' }),
  });
  const initData = await j(init);
  ok('anonymous initialize rejected', init.status === 401, `status=${init.status} ${JSON.stringify(initData).slice(0, 160)}`);

  const settle = await fetch(`${BASE}/api/payments/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: 'no-such-reference' }),
  });
  ok('anonymous settle rejected', settle.status === 401, `status=${settle.status}`);
}

// ── Test: scheduled POST requires control of payerSCA ──────────────────────
async function testScheduledControl() {
  console.log('\n[payments/scheduled]');
  const rando = ethers.Wallet.createRandom().address;
  const res = await fetch(`${BASE}/api/payments/scheduled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ payerSCA: rando, receiverSCA: rando, amount: '0.01', intervalDays: 7 }),
  });
  const data = await j(res);
  ok('uncontrolled payerSCA rejected', res.status === 403, `status=${res.status} ${JSON.stringify(data).slice(0, 160)}`);

  const noKey = await fetch(`${BASE}/api/payments/scheduled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payerSCA: rando, receiverSCA: rando, amount: '0.01', intervalDays: 7 }),
  });
  ok('no auth on scheduled rejected', noKey.status === 401, `status=${noKey.status}`);
}

// ── Test: nano POST requires control of a party ────────────────────────────
async function testNanoControl() {
  console.log('\n[payments/nano]');
  const rando = ethers.Wallet.createRandom().address;
  const res = await fetch(`${BASE}/api/payments/nano`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ agentSCA: rando, merchantSCA: rando, amount: '0.0001', description: 'auth test' }),
  });
  const data = await j(res);
  ok('uncontrolled nano rejected', res.status === 403, `status=${res.status} ${JSON.stringify(data).slice(0, 160)}`);
}

// ── Test: settle-cross-chain is internal-only ──────────────────────────────
async function testCrossChainAuth() {
  console.log('\n[settle-cross-chain]');
  const anon = await fetch(`${BASE}/api/settle-cross-chain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: 'x', messageHash: '0x', rawMessage: '0x' }),
  });
  ok('unauthenticated settle-cross-chain rejected', anon.status === 401, `status=${anon.status}`);

  const badKey = await fetch(`${BASE}/api/settle-cross-chain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'arc_live_doesnotexist' },
    body: JSON.stringify({ reference: 'x', messageHash: '0x', rawMessage: '0x' }),
  });
  ok('unknown key rejected', badKey.status === 401, `status=${badKey.status}`);
}

// ── Test: jobs create requires authentication + control of clientSCA ───────
// The route is wrapped in withApiKeyOrAnySession, so an anonymous create is
// rejected (401) before any address-control check can run — fail-closed.
async function testJobsControl() {
  console.log('\n[jobs]');
  const rando = ethers.Wallet.createRandom().address;
  const rando2 = ethers.Wallet.createRandom().address;
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', clientSCA: rando, providerSCA: rando2, amountUSDC: '1', description: 'auth test' }),
  });
  const data = await j(res);
  ok('job create without auth rejected (401)', res.status === 401, `status=${res.status} ${JSON.stringify(data).slice(0, 160)}`);
}

// ── Test: Batch 6 apply — invalid job id is a clean 404 (no onchain) ───────
// (The consumer-session test covers this with a properly controlled wallet;
// this legacy variant only asserts the control check without a session.)
async function testApplyNotFound() {
  console.log('\n[jobs/[jobId]/apply]');
  const wallet = ethers.Wallet.createRandom();
  const res = await fetch(`${BASE}/api/jobs/999999999/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ applicantAddress: wallet.address, pitch: 'Automated auth test application with a sufficiently long pitch to be meaningful.' }),
  });
  const data = await j(res);
  ok('apply with uncontrolled address → 403', res.status === 403, `status=${res.status} ${JSON.stringify(data).slice(0, 160)}`);
}

// ── Test: merchant me without cookie → 401 ─────────────────────────────────
async function testMerchantMe() {
  console.log('\n[merchant/me]');
  const res = await fetch(`${BASE}/api/merchant/me`);
  ok('merchant/me without cookie → 401', res.status === 401, `status=${res.status}`);
}

const tests = [
  testConsumerSession,
  testSettleOwnership,
  testScheduledControl,
  testNanoControl,
  testCrossChainAuth,
  testJobsControl,
  testApplyNotFound,
  testMerchantMe,
];

(async () => {
  // warm-up: wait for the server to be up
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/consumer/session`);
      if (r.status) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  for (const t of tests) {
    try { await t(); } catch (e) { failed++; console.log(`  ❌ test crashed: ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();