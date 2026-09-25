// scripts/tower-quote-probe.ts
//
// One-shot live probe: USDC->EURC Tower quote with requested-vs-returned
// token echo printed to stdout. Needs TOWER_SWAP_API_KEY in env (server
// key — never commit it, never log its value).
//
// Run:  npx tsx scripts/tower-quote-probe.ts
//   (optional) TOWER_SWAP_BASE_URL override + amount override via argv:
//           npx tsx scripts/tower-quote-probe.ts 10000
//
// Amount default is 0.01 USDC (10000 base units) — quote only, no funds move.

import { requestTowerQuote } from '@/src/lib/routing/providers/tower';
import { getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';

const inTok = getTokenBySymbol('USDC');
const outTok = getTokenBySymbol('EURC');
const amount = BigInt(process.argv[2] ?? '10000');

console.log(`[probe] request USDC->EURC amount=${amount.toString()}`);
console.log(`[probe] requested inputToken =${inTok.address}`);
console.log(`[probe] requested outputToken=${outTok.address}`);

try {
  const q = await requestTowerQuote({ inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: amount });
  console.log('[probe] QUOTE OK');
  console.log(`[probe] normalized in =${q.inputToken.address} out=${q.outputToken.address}`);
  console.log(`[probe] quotedOutput=${q.quotedOutputAmount.toString()} minOut=${q.minOutputAmount?.toString() ?? '(none)'}`);
} catch (e: any) {
  console.log(`[probe] QUOTE FAILED status=${(e as any)?.status ?? '?'} message=${String(e?.message ?? e).slice(0, 300)}`);
  process.exitCode = 1;
}
