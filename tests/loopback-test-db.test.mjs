import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertLoopbackTestDb } from '../scripts/lib/loopback-test-db.mjs';

const local = 'postgresql://test@127.0.0.1:5432/fixtures?schema=public';
const remote = 'postgresql://test:synthetic-password@neon.example/fixtures';
test('guard allows only explicit loopback PostgreSQL without host overrides', () => {
  for (const url of [local, 'postgres://localhost/test', 'postgresql://[::1]:5432/test']) assert.equal(assertLoopbackTestDb(url), url);
  for (const url of ['', remote, 'file:test', 'postgres://localhost.evil.example/test', 'postgres://localhost@evil.example/test',
    'postgres://localhost,evil.example/test', 'postgres://127.1/test', 'postgres://%6cocalhost/test',
    'postgres://localhost/test?%68ost=remote.example', 'postgres://localhost/test?hostaddr=203.0.113.1']) {
    assert.throws(() => assertLoopbackTestDb(url), /DATABASE_URL.*loopback/);
  }
});

test('runner, persistence test and fixture entry refuse a missing or remote DB before doing work', () => {
  for (const args of [['scripts/run-safe-tests.mjs'], ['--test', 'tests/deploy-persistence.test.mjs', 'tests/deploy-intent.test.mjs'], ['scripts/checkout-hardening-tests.mjs'], ['--import', 'tsx', 'scripts/wallet-security-hardening-tests.ts']]) {
    for (const value of [undefined, remote]) {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      if (value === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = value;
      const p = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      assert.equal(p.status, 1, args.join(' '));
      assert.match(p.stdout + p.stderr, /DATABASE_URL.*loopback/);
      assert.doesNotMatch(p.stdout + p.stderr, /synthetic-password/);
    }
  }
});

test('dotenv overrides and deletes cannot replace the validated DB', () => {
  const p = spawnSync(process.execPath, ['--import', './scripts/lib/require-loopback-test-db.mjs', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { populate } from 'dotenv';
    const before = process.env.DATABASE_URL;
    assert.throws(() => populate(process.env, { DATABASE_URL: 'postgres://remote.example/test' }, { override: true }), /Refusing to override/);
    assert.throws(() => delete process.env.DATABASE_URL, /Refusing to unset/);
    assert.equal(process.env.DATABASE_URL, before);
  `], { env: { ...process.env, DATABASE_URL: local }, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
});
