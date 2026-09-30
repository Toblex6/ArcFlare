// scripts/agent-legacy-tests.ts
//
// Agent test-network flag (Step F) — pure + static tests only. No DB, no
// Circle, no network: the flag was set by direct verified update (69/69),
// provisioning is untouched by this step.
//
// Run: npx tsx scripts/agent-legacy-tests.ts
//
// Covers:
//   1. Exact refusal copy + error shape.
//   2. Refusal predicate matrix (mainnet-only, flag-only, null-safe).
//   3. Spend/deploy/payment gates present on every acting path.
//   4. Mainnet hide-by-default (+ opt-in) on discover + merchant list,
//      with a page toggle.
//   5. New agents still get network-native wallets at creation (deploys
//      resolve the blockchain from config, never a hardcoded testnet id).

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_AGENT_MESSAGE,
  LegacyAgentError,
  assertAgentRowNotLegacy,
  isLegacyBlocked,
} from '@/src/lib/agents/legacyGate';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}
function expectThrow(label: string, fn: () => unknown, needle: string) {
  try {
    fn();
    ok(label, false, 'did NOT throw');
  } catch (e: any) {
    ok(label, String(e?.message ?? e).includes(needle) && (e as any)?.status === 403 && (e as any)?.code === 'LEGACY_AGENT',
      `status=${(e as any)?.status} code=${(e as any)?.code}`);
  }
}

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const MM_ENV: Record<string, string> = {
  ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042',
  ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.example',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway-api.circle.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris-api.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26',
  ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: `0x${'1'.repeat(40)}`,
  ARC_MAINNET_USDC_ADDRESS: `0x${'2'.repeat(40)}`,
  ARC_MAINNET_EURC_ADDRESS: `0x${'3'.repeat(40)}`,
  ARC_MAINNET_X402_VERIFIER: `0x${'5'.repeat(40)}`,
};

console.log('── 1: refusal copy + shape ───────────────────────────────────');
ok('exact copy', LEGACY_AGENT_MESSAGE === 'This agent was created on the test network. Create a new agent on Arc Mainnet.');
const terr = new LegacyAgentError();
ok('403 LEGACY_AGENT', terr.status === 403 && terr.code === 'LEGACY_AGENT');

console.log('── 2: predicate matrix (mainnet-only, flag-only) ─────────────');
ok('legacy + mainnet → blocked', isLegacyBlocked({ isLegacy: true }, MM_ENV));
ok('legacy + testnet → NOT blocked', !isLegacyBlocked({ isLegacy: true }, {}));
ok('fresh + mainnet → NOT blocked', !isLegacyBlocked({ isLegacy: false }, MM_ENV));
ok('flagless + mainnet → NOT blocked', !isLegacyBlocked({}, MM_ENV));
ok('null row → NOT blocked', !isLegacyBlocked(null, MM_ENV));
expectThrow('assert throws 403 on mainnet legacy', () => assertAgentRowNotLegacy({ isLegacy: true }, MM_ENV), 'test network');
ok('assert passes testnet legacy', (() => { assertAgentRowNotLegacy({ isLegacy: true }, {}); return true; })());

console.log('── 3–5: wiring (static proofs) ───────────────────────────────');
const gate = read('src/lib/agents/legacyGate.ts');
ok('gate is mainnet-only with zero testnet queries', gate.includes('getNetworkConfig(env).name !== "mainnet"'));

const gated: Array<[string, string]> = [
  ['src/app/api/agents/[id]/treasury/credit/route.ts', 'isLegacyBlocked(refAgent)'],
  ['src/app/api/agents/[id]/treasury/hire/route.ts', 'isLegacyBlocked(hirerRef)'],
  ['src/app/api/agents/[id]/treasury/hire/route.ts', 'isLegacyBlocked(providerRef)'],
  ['src/app/api/agents/[id]/treasury/route.ts', 'isLegacyBlocked(agent)'],
  ['src/app/api/agents/[id]/pay/route.ts', 'isLegacyBlocked(agent)'],
  ['src/app/api/agents/[id]/hire/route.ts', 'isLegacyBlocked(agent)'],
  ['src/lib/agents/agentPay.ts', 'isLegacyBlocked(agent)'],
  ['src/app/api/agent/deploy/recover/route.ts', 'isLegacyBlocked(existing)'],
];
for (const [f, needle] of gated) {
  ok(`${f.split('/').slice(-2).join('/')} gates legacy`, read(f).includes(needle));
}
ok('agentPay also gates the recipient', read('src/lib/agents/agentPay.ts').includes('isLegacyBlocked(recipientAgent)'));

const discover = read('src/app/api/agents/discover/route.ts');
ok('discover hides legacy on mainnet unless opted in', discover.includes('includeLegacy') && discover.includes('where.isLegacy = false'));
const list = read('src/app/api/agent/list/route.ts');
ok('merchant list hides legacy on mainnet unless opted in', list.includes('includeLegacy') && list.includes('isLegacy: false'));
const page = read('src/app/agents/page.tsx');
ok('page has show-legacy toggle (mainnet only) + badge', page.includes('showLegacy') && page.includes('Show legacy (test-network) agents') && page.includes('legacy · test network'));

const deploy = read('src/app/api/agent/deploy/route.ts');
ok('deploy provisions on the configured network blockchain (mainnet → ARC)', deploy.includes('getNetworkConfig().circleBlockchain'));
const schema = read('prisma/schema.prisma');
ok('AgentRegistry carries isLegacy default false', /model AgentRegistry[\s\S]*?isLegacy\s+Boolean\s+@default\(false\)/.test(schema));

console.log(`\nagent-legacy-tests: ${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
