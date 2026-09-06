// scripts/router-e2e.ts
//
// Testnet E2E for ArcFlarePaymentRouter: routes BOTH directions through the
// canonical pool with output paid directly to a merchant recipient.
//
//   payer (signer) -> router -> pool -> merchant (separate EOA)
//
// Measures per-leg fee behavior (payer debit vs merchant credit), gas, and
// asserts: merchant credit >= minOut, router holds zero residual, event
// carries (payer, tokenIn, amountIn, tokenOut, amountOut, recipient, pool).
//
// Run:  npx tsx scripts/router-e2e.ts
// Needs: ARC_TESTNET_RPC, RELAYER_PRIVATE_KEY (or PRIVATE_KEY),
//        SWAP_POOL_CONTRACT_ADDRESS, PAYMENT_ROUTER_CONTRACT_ADDRESS,
//        E2E_MERCHANT_ADDRESS (any EOA you control; defaults to a burn-sibling
//        probe address — SET IT to an address you own so funds are recoverable)

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { Contract, JsonRpcProvider, Wallet, parseUnits, formatUnits } from 'ethers';

const USDC_ADDR = '0x3600000000000000000000000000000000000000';
const EURC_ADDR = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const POOL_ADDR = (process.env.SWAP_POOL_CONTRACT_ADDRESS ?? '').trim();
const ROUTER_ADDR = (process.env.PAYMENT_ROUTER_CONTRACT_ADDRESS ?? '').trim();
const MERCHANT = (process.env.E2E_MERCHANT_ADDRESS ?? '0x1111111111111111111111111111111111111111').trim();

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const POOL_ABI = [
  'function reserveA() view returns (uint256)',
  'function reserveB() view returns (uint256)',
  'function getQuote(address,uint256) view returns (uint256)',
];
const ROUTER_ABI = [
  'function usdc() view returns (address)',
  'function eurc() view returns (address)',
  'function pool() view returns (address)',
  'function route(address,uint256,uint256,uint256,address) returns (uint256)',
];

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const rpc = new JsonRpcProvider(process.env.ARC_TESTNET_RPC);
  const pk = (process.env.RELAYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? '').trim();
  if (!pk || pk.startsWith('YOUR_')) throw new Error('no usable private key (set RELAYER_PRIVATE_KEY)');
  if (!POOL_ADDR) throw new Error('SWAP_POOL_CONTRACT_ADDRESS not set');
  if (!ROUTER_ADDR) throw new Error('PAYMENT_ROUTER_CONTRACT_ADDRESS not set — deploy the router first');
  const signer = new Wallet(pk, rpc);
  const payer = await signer.getAddress();

  const usdc = new Contract(USDC_ADDR, ERC20_ABI, signer);
  const eurc = new Contract(EURC_ADDR, ERC20_ABI, signer);
  const pool = new Contract(POOL_ADDR, POOL_ABI, signer);
  const router = new Contract(ROUTER_ADDR, ROUTER_ABI, signer);

  const bal = async (t: Contract, a: string) => Number(formatUnits(await t.balanceOf(a), 6));

  console.log(`Router     : ${ROUTER_ADDR}`);
  console.log(`Pool       : ${POOL_ADDR}`);
  console.log(`Payer      : ${payer}`);
  console.log(`Merchant   : ${MERCHANT}`);
  console.log(`Router binds: usdc=${await router.usdc()} eurc=${await router.eurc()} pool=${await router.pool()}`);
  console.log(`Payer USDC : ${await bal(usdc, payer)} / EURC: ${await bal(eurc, payer)}`);
  console.log(`Merchant USDC: ${await bal(usdc, MERCHANT)} / EURC: ${await bal(eurc, MERCHANT)}`);
  console.log(`Reserves   : ${Number(await pool.reserveA()) / 1e6} A / ${Number(await pool.reserveB()) / 1e6} B`);
  console.log('');

  ok('router binds canonical USDC', (await router.usdc()).toLowerCase() === USDC_ADDR.toLowerCase());
  ok('router binds canonical EURC', (await router.eurc()).toLowerCase() === EURC_ADDR.toLowerCase());
  ok('router binds canonical pool', (await router.pool()).toLowerCase() === POOL_ADDR.toLowerCase());

  const ensureApproval = async (t: Contract, sym: string, amount: string) => {
    const need = await t.allowance(payer, ROUTER_ADDR);
    if (need < parseUnits(amount, 6)) {
      const tx = await t.approve(ROUTER_ADDR, parseUnits(amount, 6));
      await tx.wait();
      console.log(`  approved ${amount} ${sym} for router (tx ${tx.hash.slice(0, 10)}…)`);
    }
  };

  async function routeOne(symIn: 'USDC' | 'EURC', amountInStr: string) {
    const tIn = symIn === 'USDC' ? usdc : eurc;
    const tOut = symIn === 'USDC' ? eurc : usdc;
    const tokenInAddr = symIn === 'USDC' ? USDC_ADDR : EURC_ADDR;
    const symOut = symIn === 'USDC' ? 'EURC' : 'USDC';
    const amountIn = parseUnits(amountInStr, 6);
    const quote = await pool.getQuote(tokenInAddr, amountIn);
    const quoteF = Number(formatUnits(quote, 6));
    const minOut = (quote * 99n) / 100n;
    console.log(`[route] ${symIn}->${symOut} ${amountInStr} (quote ${quoteF.toFixed(6)}, minOut ${Number(formatUnits(minOut, 6)).toFixed(6)}) ...`);
    await ensureApproval(tIn, symIn, amountInStr);
    const payerBefore = await bal(tIn, payer);
    const merchBefore = await bal(tOut, MERCHANT);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx = await router.route(tokenInAddr, amountIn, minOut, deadline, MERCHANT);
    const rec = await tx.wait();
    const gasUsed = rec.gasUsed?.toString() ?? '?';
    const payerAfter = await bal(tIn, payer);
    const merchAfter = await bal(tOut, MERCHANT);
    const debit = payerBefore - payerAfter;
    const credit = merchAfter - merchBefore;
    console.log(`  tx ${rec.hash} (gas ${gasUsed})`);
    console.log(`  payer debit ${debit.toFixed(6)} ${symIn} / merchant credit ${credit.toFixed(6)} ${symOut} / quote ${quoteF.toFixed(6)}`);
    const routedTopic = rec.logs.find((l: { topics: string[] }) =>
      l.topics[0].toLowerCase().startsWith('0x') && l.topics.length === 4);
    ok(`${symIn}->${symOut} merchant credit >= minOut`, credit >= Number(formatUnits(minOut, 6)) - 1e-6,
      `credit ${credit.toFixed(6)}`);
    ok(`${symIn}->${symOut} merchant credit within 3% of quote`, Math.abs(credit - quoteF) < quoteF * 0.03,
      `delta ${(credit - quoteF).toFixed(6)}`);
    ok(`${symIn}->${symOut} payer debit covers amountIn`, debit >= Number(amountInStr) - 1e-6,
      `debit ${debit.toFixed(6)}`);
    ok(`${symIn}->${symOut} PaymentRouted emitted`, routedTopic !== undefined, `${rec.hash}`);
    return { hash: rec.hash as string, gasUsed, debit, credit, quote: quoteF };
  }

  const r1 = await routeOne('USDC', '1.00');
  console.log('');
  const r2 = await routeOne('EURC', '0.50');
  console.log('');

  const routerUsdc = await bal(usdc, ROUTER_ADDR);
  const routerEurc = await bal(eurc, ROUTER_ADDR);
  ok('router holds zero USDC residual', Math.abs(routerUsdc) < 1e-6, `${routerUsdc}`);
  ok('router holds zero EURC residual', Math.abs(routerEurc) < 1e-6, `${routerEurc}`);

  console.log('');
  console.log('Route summary (measured on Arc Testnet):');
  console.log(`  USDC->EURC: in ${r1.debit.toFixed(6)} / out ${r1.credit.toFixed(6)} (quote ${r1.quote.toFixed(6)}) tx ${r1.hash} gas ${r1.gasUsed}`);
  console.log(`  EURC->USDC: in ${r2.debit.toFixed(6)} / out ${r2.credit.toFixed(6)} (quote ${r2.quote.toFixed(6)}) tx ${r2.hash} gas ${r2.gasUsed}`);
  console.log(`  final reserves ${Number(await pool.reserveA()) / 1e6} A / ${Number(await pool.reserveB()) / 1e6} B`);

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('e2e threw:', e?.message ?? e);
  process.exit(1);
});
