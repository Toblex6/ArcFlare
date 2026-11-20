import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { assertLoopbackTestDb } from './lib/loopback-test-db.mjs';
import { MAINNET_ENV } from '../tests/fixtures/mainnet-env.mjs';

const url = assertLoopbackTestDb();
const os = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|TEMP|TMP)$/i.test(key)));
const env = { ...os, ARC_NETWORK: 'testnet', NEXT_PUBLIC_ARC_NETWORK: 'testnet', NODE_ENV: 'test',
  DATABASE_URL: url, __NEXT_PROCESSED_ENV: 'true', SENTRY_AUTH_TOKEN: '', NEXT_TELEMETRY_DISABLED: '1' };
const dbEnv = { ...MAINNET_ENV, ...env, ARC_TESTNET_RPC: 'http://127.0.0.1:1', SPEND_LIMIT_CONTRACT_ADDRESS: '' };
const support = ['--import', './scripts/lib/require-loopback-test-db.mjs', '--import', './scripts/lib/offline-test-env.mjs', '--import', 'tsx'];

// Explicit allowlist: older e2e scripts can send real transactions or call
// live wallet services. Never run them here by glob or name convention.
const offline = [
  'arcscan-links-tests.mjs', 'checkout-bridge-tests.ts', 'checkout-settlement-tests.ts',
  'flarehq-jobs-tests.ts', 'standalone-stream-tests.ts', 'x402-mainnet-tests.ts',
  'erc8004-mainnet-tests.ts', 'legal-pages-tests.ts', 'bridge-kit-mainnet-tests.ts',
  'routing-providers-tests.ts', 'unitflow-execution-tests.ts', 'run-static-bridge-guards.mjs',
];
const database = [
  'build5-procurement-tests.ts', 'procurement-bigint-e2e.ts', 'spend-window-atomicity-tests.ts',
  'phase2d-ledger-tests.ts', 'routing-schema-tests.ts', 'routing-preference-tests.ts',
];
const localContracts = ['test-escrow-local.mjs', 'test-stream-local.mjs', 'test-payment-router-local.mjs'];
const tests = readdirSync('tests').filter((p) => p.endsWith('.test.mjs')).map((p) => `tests/${p}`);
const stages = [
  ['node test suites', [...support, '--test', ...tests]],
  ...offline.map((p) => [p, ['--experimental-test-module-mocks', ...support, `scripts/${p}`]]),
  ...database.map((p) => [p, [...support, `scripts/${p}`], dbEnv]),
  ...localContracts.map((p) => [p, ['node_modules/hardhat/dist/src/cli.js', '--config', 'hardhat.local.config.js', 'run', `scripts/${p}`]]),
  ['mainnet optional boot', ['scripts/mainnet-optional-boot-tests.mjs']],
];
let passed = 0;
let failed = 0;
for (const [name, args, stageEnv = env] of stages) {
  console.log(`\n[${name}]`);
  const result = spawnSync(process.execPath, args, { env: stageEnv, stdio: 'inherit', timeout: 240_000 });
  if (result.status === 0) passed++;
  else { failed++; console.error(`[${name}] failed (exit ${result.status ?? result.error?.code ?? 'unknown'})`); }
}
console.log(`\nSafe regression stages: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
