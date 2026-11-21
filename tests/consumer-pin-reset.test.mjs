// Actual handlers + canonical helpers, entirely in-memory. No DB/RPC/wallets.
// Synthetic credentials are generated at runtime and never printed/asserted as
// values, including on assertion failure. No real credentials in fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function compile(path, stubs, logs = []) {
  const source = ts.transpileModule(file(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', source)((name) => {
    const key = name.replace('@/src/', '@/');
    if (Object.hasOwn(stubs, key)) return stubs[key];
    if (key === 'node:crypto') return require(key);
    throw new Error('Unexpected unmocked dependency');
  }, module, module.exports, Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map((name) => [name, (...args) => logs.push(args)])));
  return module.exports;
}

function setup(options = {}) {
  const secrets = { current: String(randomInt(100000, 400000)), replacement: String(randomInt(500000, 800000)), wrong: String(randomInt(810000, 999999)) };
  const initialHash = 'synthetic-encoded-credential';
  const account = { id: 'account-a', walletAddress: `0x${'ab'.repeat(20)}`, pinHash: initialHash, pinFailedAttempts: 0, pinLockedUntil: null, email: 'owner@example.test', emailVerifiedAt: new Date(), ...options.account };
  const logs = [], writes = [], sent = [], limits = [];
  let otpRows = [], count = 0, allow = true, session = options.session === false ? null : account.walletAddress;
  let compareHook = null, beforeWrite = null, dbFailure = false;
  const accountDb = {
    findUnique: async () => ({ ...account }),
    update: async ({ data }) => {
      for (const [key, value] of Object.entries(data)) account[key] = typeof value === 'object' && value?.increment ? account[key] + value.increment : value;
      return { ...account };
    },
    updateMany: async ({ where, data }) => {
      if (beforeWrite) beforeWrite();
      if (dbFailure) throw new Error('Synthetic database failure');
      if (where.pinHash !== account.pinHash || (where.email && where.email !== account.email) ||
        (where.OR && account.pinLockedUntil && +account.pinLockedUntil > Date.now())) return { count: 0 };
      writes.push(Object.keys(data)); Object.assign(account, data); return { count: 1 };
    },
  };
  const otpDb = {
    create: async ({ data }) => { const row = { id: `otp-${++count}`, attempts: 0, consumedAt: null, ...data }; otpRows.push(row); return row; },
    findMany: async ({ where }) => otpRows.filter((r) => r.email === where.email && r.purpose === where.purpose).slice(-1),
    update: async ({ where }) => { const row = otpRows.find((r) => r.id === where.id); if (!row) throw new Error('Missing row'); row.attempts++; return { attempts: row.attempts }; },
    delete: async ({ where }) => { otpRows = otpRows.filter((r) => r.id !== where.id); },
    deleteMany: async ({ where }) => {
      const before = otpRows.length;
      otpRows = otpRows.filter((r) => where.id ? !(r.id === where.id && r.codeHash === where.codeHash && +r.expiresAt > +where.expiresAt.gt) : !(r.email === where.email && r.purpose === where.purpose));
      return { count: before - otpRows.length };
    },
  };
  const stubs = {
    'next/server': { NextResponse: { json: (body, options = {}) => new Response(JSON.stringify(body), options) } },
    '@/lib/prisma': { prisma: { consumerAccount: accountDb, consumerEmailOtp: otpDb } },
    '@/lib/middleware/withConsumerAuth': { resolveConsumerSession: async () => session },
    '@/lib/ratelimit': { checkRateLimit: async (_req, type) => { limits.push(type); return allow ? { allowed: true } : { allowed: false, response: new Response('{}', { status: 429 }) }; } },
    'bcryptjs': { hash: async () => 'synthetic-new-encoded-credential', compare: async (candidate) => { if (compareHook) compareHook(); return candidate === secrets.current; } },
    '@/lib/email': { generateVerificationCode: () => String(randomInt(100000, 999999)), sendConsumerOtpEmail: async (email, code, purpose) => { sent.push({ email, code, purpose }); } },
  };
  const step = compile('src/lib/auth/consumerStepUp.ts', stubs, logs);
  stubs['@/lib/auth/consumerStepUp'] = step;
  const otp = compile('src/lib/auth/consumerOtp.ts', stubs, logs);
  stubs['@/lib/auth/consumerOtp'] = otp;
  const pin = compile('src/app/api/consumer/pin/route.ts', stubs, logs);
  const reset = compile('src/app/api/consumer/pin/reset/route.ts', stubs, logs);
  function request(body = {}, candidate = undefined) { return new Request('https://example.test/api/consumer/pin', { method: 'PUT', headers: { 'content-type': 'application/json', ...(candidate ? { 'x-consumer-pin': candidate } : {}) }, body: JSON.stringify(body) }); }
  const changeBody = () => ({ newPin: secrets.replacement, confirmPin: secrets.replacement });
  async function issue(purpose = 'PIN_RESET', id = account.id) { return (await otp.issueConsumerOtp({ email: account.email, purpose, accountId: id })).code; }
  return { account, pin, reset, step, otp, request, secrets, logs, writes, sent, limits, changeBody, issue,
    rows: () => otpRows, initialHash,
    setRate: (v) => { allow = v; }, setSession: (v) => { session = v; },
    raceCompare: (fn) => { compareHook = fn; }, raceWrite: (fn) => { beforeWrite = fn; }, failDb: () => { dbFailure = true; } };
}

test('wrong current credential rejects a change through canonical step-up', async () => {
  const s = setup(); const r = await s.pin.PUT(s.request(s.changeBody(), s.secrets.wrong));
  assert.equal(r.status, 403); assert.equal(s.account.pinFailedAttempts, 1); assert.equal(s.writes.length, 0);
  assert.ok(s.account.pinHash === s.initialHash); assert.equal(s.logs.length, 0);
});
test('five failures lock the account and a correct credential cannot clear the lock', async () => {
  const s = setup(); let r;
  for (let i = 0; i < 5; i++) r = await s.pin.PUT(s.request(s.changeBody(), s.secrets.wrong));
  assert.equal(r.status, 423); const lock = +s.account.pinLockedUntil;
  r = await s.pin.PUT(s.request(s.changeBody(), s.secrets.current));
  assert.equal(r.status, 423); assert.equal(+s.account.pinLockedUntil, lock); assert.equal(s.writes.length, 0);
});
test('successful change requires the current credential and matching new entries', async () => {
  const s = setup(); const r = await s.pin.PUT(s.request(s.changeBody(), s.secrets.current));
  assert.equal(r.status, 200); assert.ok(s.account.pinHash !== s.initialHash);
  assert.deepEqual(s.writes, [['pinHash']]); assert.ok(s.limits.every((t) => t === 'withdraw'));
  assert.ok(!JSON.stringify(await r.json()).includes(s.secrets.current)); assert.equal(s.logs.length, 0);
});
test('missing current credential and mismatched confirmation cannot change the PIN', async () => {
  const s = setup(); assert.equal((await s.pin.PUT(s.request(s.changeBody()))).status, 403);
  assert.equal((await s.pin.PUT(s.request({ newPin: s.secrets.replacement }, s.secrets.current))).status, 400);
  assert.equal(s.writes.length, 0);
});
test('concurrent lockout during verification remains enforced', async () => {
  const s = setup(); s.raceCompare(() => { s.account.pinLockedUntil = new Date(Date.now() + 900000); });
  assert.equal((await s.pin.PUT(s.request(s.changeBody(), s.secrets.current))).status, 423); assert.equal(s.writes.length, 0);
});
test('racing lockout immediately before the PIN write is not cleared', async () => {
  const s = setup(); s.raceWrite(() => { s.account.pinLockedUntil = new Date(Date.now() + 900000); });
  assert.equal((await s.pin.PUT(s.request(s.changeBody(), s.secrets.current))).status, 409); assert.equal(s.writes.length, 0);
});
test('PIN recovery sends only to the existing verified email with a separate OTP purpose', async () => {
  const s = setup(); const r = await s.reset.POST(s.request({ email: 'attacker@example.test', accountId: 'other' }));
  assert.equal(r.status, 200); assert.equal(s.sent.length, 1); assert.equal(s.sent[0].email, s.account.email);
  assert.equal(s.rows()[0].purpose, 'PIN_RESET'); assert.equal(s.rows()[0].accountId, s.account.id);
  assert.ok(!JSON.stringify(await r.json()).includes(s.sent[0].code)); assert.equal(s.logs.length, 0);
});
for (const scenario of ['missing', 'wrong', 'expired', 'wrong-purpose', 'wrong-account']) {
  test(`${scenario} recovery proof cannot change the PIN`, async () => {
    const s = setup(); let code = await s.issue(scenario === 'wrong-purpose' ? 'EMAIL_LOGIN' : 'PIN_RESET', scenario === 'wrong-account' ? 'other' : s.account.id);
    if (scenario === 'expired') s.rows()[0].expiresAt = new Date(0);
    if (scenario === 'wrong') code = 'invalid';
    const r = await s.reset.PUT(s.request({ ...s.changeBody(), ...(scenario === 'missing' ? {} : { code }) }));
    assert.equal(r.status, 400); assert.equal(s.writes.length, 0); assert.ok(s.account.pinHash === s.initialHash);
  });
}
test('valid fresh OTP resets once without clearing a pre-existing PIN lockout', async () => {
  const s = setup({ account: { pinFailedAttempts: 5, pinLockedUntil: new Date(Date.now() + 900000) } });
  const lock = +s.account.pinLockedUntil, code = await s.issue();
  const r = await s.reset.PUT(s.request({ ...s.changeBody(), code }));
  assert.equal(r.status, 200); assert.equal(s.account.pinFailedAttempts, 5); assert.equal(+s.account.pinLockedUntil, lock);
  assert.deepEqual(s.writes, [['pinHash']]);
  assert.equal((await s.reset.PUT(s.request({ ...s.changeBody(), code }))).status, 400); assert.equal(s.writes.length, 1);
  assert.equal((await s.pin.PUT(s.request(s.changeBody(), s.secrets.current))).status, 423);
  assert.equal(s.logs.length, 0);
});
test('OTP attempts remain bounded and single-use under concurrent claims', async () => {
  const s = setup(); let code = await s.issue();
  for (let i = 0; i < 5; i++) await s.otp.verifyConsumerOtp({ email: s.account.email, purpose: 'PIN_RESET', code: 'invalid' });
  assert.ok(!(await s.otp.verifyConsumerOtp({ email: s.account.email, purpose: 'PIN_RESET', code })).ok);
  code = await s.issue();
  const claims = await Promise.all([0, 1].map(() => s.otp.verifyConsumerOtp({ email: s.account.email, purpose: 'PIN_RESET', code })));
  assert.equal(claims.filter((r) => r.ok).length, 1);
});
test('no session, unverified email, or exhausted rate limit fails closed', async () => {
  const anonymous = setup({ session: false });
  assert.equal((await anonymous.reset.POST(anonymous.request())).status, 401);
  assert.equal((await anonymous.reset.PUT(anonymous.request(anonymous.changeBody()))).status, 401);
  const unverified = setup({ account: { emailVerifiedAt: null } });
  assert.equal((await unverified.reset.POST(unverified.request())).status, 409); assert.equal(unverified.sent.length, 0);
  const limited = setup(); limited.setRate(false);
  for (const route of [limited.reset.POST, limited.reset.PUT, limited.pin.PUT]) assert.equal((await route(limited.request())).status, 429);
  assert.equal(limited.writes.length, 0); assert.equal(limited.sent.length, 0);
});
test('recovery cannot overwrite a concurrent email or credential change', async () => {
  const s = setup(); const code = await s.issue();
  s.raceWrite(() => { s.account.email = 'changed@example.test'; });
  assert.equal((await s.reset.PUT(s.request({ ...s.changeBody(), code }))).status, 400); assert.equal(s.writes.length, 0);
});
test('enrollment cannot overwrite a PIN enrolled concurrently', async () => {
  const s = setup({ account: { pinHash: null } });
  s.raceWrite(() => { s.account.pinHash = s.initialHash; });
  assert.equal((await s.pin.POST(s.request({ pin: s.secrets.replacement }))).status, 409);
  assert.equal(s.writes.length, 0); assert.ok(s.account.pinHash === s.initialHash);
});
test('first enrollment succeeds only while no credential exists', async () => {
  const s = setup({ account: { pinHash: null } });
  assert.equal((await s.pin.POST(s.request({ pin: s.secrets.replacement }))).status, 200);
  assert.equal(s.writes.length, 1);
  assert.equal((await s.pin.POST(s.request({ pin: s.secrets.current }))).status, 409);
  assert.equal(s.writes.length, 1);
});
test('ORM errors are generic; no secret/header/hash is logged or returned', async () => {
  const s = setup(); s.failDb();
  const r = await s.pin.PUT(s.request(s.changeBody(), s.secrets.current));
  assert.equal(r.status, 503); assert.equal(s.logs.length, 0);
  const text = await r.text();
  assert.ok(Object.values(s.secrets).every((secret) => !text.includes(secret))); assert.ok(!text.includes(s.initialHash));
});
test('telemetry strips custom PIN headers and request bodies in all runtimes', () => {
  const { scrubTelemetry, filterPrivateEvent } = compile('src/lib/telemetryPrivacy.ts', {});
  const marker = 'synthetic-private-value';
  const event = { request: { url: '/api/escrow/release', headers: { 'x-consumer-pin': marker }, data: JSON.stringify({ newPin: marker }) }, extra: { pinHash: marker }, attributes: { 'http.request.header.x-consumer-pin': marker } };
  assert.ok(!JSON.stringify(scrubTelemetry(event)).includes(marker));
  assert.equal(filterPrivateEvent({ request: { url: '/api/consumer/pin/reset' } }), null);
  for (const path of ['sentry.server.config.ts', 'sentry.edge.config.ts', 'src/instrumentation-client.ts']) {
    const config = file(path); assert.match(config, /beforeSend: filterPrivateEvent/); assert.match(config, /beforeBreadcrumb: scrubTelemetry/); assert.match(config, /beforeSendLog: scrubTelemetry/);
  }
});
test('new consumer controls reuse masked dialogs; no secret persistence, console, or browser prompts', () => {
  const ui = file('src/components/ConsumerPinSettings.tsx');
  assert.match(ui, /useSecurePinDialog/); assert.match(ui, /Change PIN/); assert.match(ui, /Forgot PIN/);
  assert.doesNotMatch(ui, /console\.|localStorage|sessionStorage|window\.prompt/);
  assert.match(ui, /headers\['x-consumer-pin'\] = currentPin/); assert.match(ui, /newPin, confirmPin/);
  assert.match(file('src/app/consumer/page.tsx'), /ConsumerPinSettings key=\{walletAddress\}/);
});
