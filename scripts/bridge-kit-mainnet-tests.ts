// scripts/bridge-kit-mainnet-tests.ts
//
// Mainnet external bridge via Circle Bridge Kit (Step D) — pure + static
// tests only. No DB, no wallets, no broadcasts: the 1 USDC live test is
// manual (user-confirmed) before any docs claim.
//
// Run: npx tsx scripts/bridge-kit-mainnet-tests.ts
//
// Covers:
//   1. Mainnet source table derives from the INSTALLED kit defs (chainId,
//      USDC, explorer template) — never hardcoded CCTP addresses.
//   2. Testnet table byte-identical (default helpers unchanged).
//   3. Stored-intent lookup is deterministic across both tables.
//   4. Verify-side kit maps cover every mainnet source + Arc def.
//   5. Routes + UI branch by network (intent open, verify/complete
//      network-aware, gas notice, fee estimate, burn+mint links, retry).

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getBridgeSourceChains,
  getBridgeSourceChain,
  findBridgeSourceChain,
  isSupportedBridgeSource,
  sourceExplorerTxUrl,
} from '@/src/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/src/lib/bridge/sourceViemChains';
import { sourceCctpV2, sourceBridgeContract } from '@/src/lib/bridge/externalVerify';
import {
  Ethereum as KitEthereum,
  Base as KitBase,
  Arbitrum as KitArbitrum,
  Optimism as KitOptimism,
  Polygon as KitPolygon,
  Avalanche as KitAvalanche,
  Arc as KitArc,
} from '@circle-fin/bridge-kit/chains';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const ADDR = /^0x[0-9a-fA-F]{40}$/;

console.log('── 1: mainnet table derives from installed kit defs ──────────');
const KIT: Array<[string, any]> = [
  ['Ethereum', KitEthereum],
  ['Base', KitBase],
  ['Arbitrum', KitArbitrum],
  ['Optimism', KitOptimism],
  ['Polygon', KitPolygon],
  ['Avalanche', KitAvalanche],
];
const mains = getBridgeSourceChains('mainnet');
ok('six mainnet sources', mains.length === 6, `got ${mains.length}`);
for (const [id, def] of KIT) {
  const row = mains.find((s) => s.id === id);
  ok(`${id} chainId matches kit`, row?.chainId === (def as any).chainId, String(row?.chainId));
  ok(`${id} USDC matches kit`, row?.usdcAddress.toLowerCase() === String((def as any).usdcAddress).toLowerCase(), row?.usdcAddress);
  ok(`${id} explorer template matches kit`, row?.explorerTxTemplate === (def as any).explorerUrl, row?.explorerTxTemplate);
  const cctp = sourceCctpV2(id);
  ok(`${id} kit CCTP v2 map resolves`, !!cctp && ADDR.test(cctp.tokenMessenger) && ADDR.test(cctp.messageTransmitter) && Number.isInteger(cctp.domain));
  const tm = (def as any)?.cctp?.contracts?.v2?.tokenMessenger;
  ok(`${id} map equals kit def`, cctp?.tokenMessenger.toLowerCase() === String(tm).toLowerCase());
  ok(`${id} viem chain resolves`, sourceViemChainFor(row!.chainId)?.id === row!.chainId);
}
ok('Arc kit def matches production topology', (KitArc as any).chainId === 5042 && String((KitArc as any).usdcAddress).toLowerCase() === '0x3600000000000000000000000000000000000000' && (KitArc as any).cctp?.domain === 26);

console.log('── 2: testnet table unchanged ─────────────────────────────────');
const tests = getBridgeSourceChains();
ok('five testnet sources by default', tests.length === 5 && getBridgeSourceChains('testnet').length === 5);
ok('default lookups stay testnet', getBridgeSourceChain('Base_Sepolia')?.chainId === 84532 && !isSupportedBridgeSource('Base') && sourceExplorerTxUrl('Base_Sepolia', '0xabc') === 'https://sepolia.basescan.org/tx/0xabc');

console.log('── 3: stored-intent lookup ────────────────────────────────────');
ok('mainnet id resolves with network', findBridgeSourceChain('Base')?.network === 'mainnet');
ok('testnet id resolves with network', findBridgeSourceChain('Base_Sepolia')?.network === 'testnet');
ok('unknown id → null (never invented)', findBridgeSourceChain('Nope') === null);

console.log('── 4–5: wiring (static proofs) ───────────────────────────────');
const intent = read('src/app/api/cctp/transfer/external/intent/route.ts');
ok('intent no longer refuses mainnet', !intent.includes('BRIDGE_DISABLED_ON_MAINNET'));
ok('intent resolves sources per network', intent.includes("getBridgeSourceChain(sourceChain, network)"));
const verify = read('src/app/api/cctp/transfer/external/verify/route.ts');
ok('verify looks up across tables', verify.includes('findBridgeSourceChain(intent.sourceChain)'));
const complete = read('src/app/api/cctp/transfer/external/complete/route.ts');
ok('complete looks up across tables', complete.includes('findBridgeSourceChain(updated.sourceChain)'));
const ui = read('src/components/bridge/ExternalBridge.tsx');
ok('UI sources follow the network', ui.includes("getBridgeSourceChains(bridgeNetwork)"));
ok('UI bridges to kit Arc on mainnet', ui.includes("bridgeNetwork === 'mainnet' ? 'Arc' : 'Arc_Testnet'"));
ok('UI gas notice names source gas + relayed mint', ui.includes('gas (approve + burn)') && ui.includes('The Arc mint is relayed'));
ok('UI fee estimate via kit.estimate (best-effort)', ui.includes('kit).estimate({') || ui.includes('.estimate({'));
ok('UI keeps burn+mint links + resume', ui.includes('View source transaction') && ui.includes('View destination transaction') && ui.includes('Resume bridge'));
const pkg = JSON.parse(read('package.json'));
ok('adapter-viem-v2 is a direct dependency', typeof pkg.dependencies['@circle-fin/adapter-viem-v2'] === 'string');

console.log(`\nbridge-kit-mainnet-tests: ${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
