// scripts/swap-pool-e2e.ts
//
// Real testnet E2E for ArcFlareSwapPool (0xaD4F3634a64685CB7dff08B82fb742e4ca7f7451):
//   seed liquidity -> getQuote vs actual swap (both directions) -> second
//   addLiquidity -> removeLiquidity round-trip.
//
// Measures USDC/EURC transfer-fee behavior on every hop (debit vs credit) —
// Arc testnet USDC charges fees (flat EOA->EOA, ~12.3% extra into contract
// addresses), EURC behavior is measured here for the first time.
//
// Run:  npx tsx scripts/swap-pool-e2e.ts

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { Contract, JsonRpcProvider, Wallet, parseUnits, formatUnits } from 'ethers';

const USDC_ADDR = '0x3600000000000000000000000000000000000000';
const EURC_ADDR = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const POOL_ADDR = process.env.SWAP_POOL_CONTRACT_ADDRESS ?? '';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
];
const POOL_ABI = [
  'function tokenA() view returns (address)',
  'function tokenB() view returns (address)',
  'function reserveA() view returns (uint256)',
  'function reserveB() view returns (uint256)',
  'function totalLiquidityShares() view returns (uint256)',
  'function liquidityShares(address) view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
  'function getQuote(address,uint256) view returns (uint256)',
  'function addLiquidity(uint256,uint256) returns (uint256)',
  'function removeLiquidity(uint256) returns (uint256,uint256)',
  'function swap(address,uint256,uint256) returns (uint256)',
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
  const signer = new Wallet(pk, rpc);
  const relayer = await signer.getAddress();
  if (!POOL_ADDR) throw new Error('SWAP_POOL_CONTRACT_ADDRESS not set');

  const usdc = new Contract(USDC_ADDR, ERC20_ABI, signer);
  const eurc = new Contract(EURC_ADDR, ERC20_ABI, signer);
  const pool = new Contract(POOL_ADDR, POOL_ABI, signer);

  const bal = async (t: Contract, a: string) => Number(formatUnits(await t.balanceOf(a), 6));

  console.log(`Pool       : ${POOL_ADDR}`);
  console.log(`Signer     : ${relayer}`);
  console.log(`USDC bal   : ${await bal(usdc, relayer)}`);
  console.log(`EURC bal   : ${await bal(eurc, relayer)}`);
  console.log(`Pool A/B   : ${await pool.tokenA()} / ${await pool.tokenB()}`);
  console.log(`Reserves   : ${Number(await pool.reserveA()) / 1e6} A / ${Number(await pool.reserveB()) / 1e6} B (fee ${await pool.FEE_BPS()}bps)`);
  console.log('');

  const approve = async (t: Contract, amount: string) => {
    const need = await t.allowance(relayer, POOL_ADDR);
    if (need < parseUnits(amount, 6)) {
      const tx = await t.approve(POOL_ADDR, parseUnits(amount, 6));
      await tx.wait();
      console.log(`  approved ${amount} ${t === usdc ? 'USDC' : 'EURC'} for pool (tx ${tx.hash.slice(0, 10)}…)`);
    }
  };

  // one-time generous approvals so every op (seed, swaps, adds) is covered
  await approve(usdc, '100');
  await approve(eurc, '100');

  // ── 1. seed liquidity: 15.12 USDC + 14.00 EURC (1 EURC ≈ 1.08 USDC) ─────
  // (idempotent: skips if the pool is already funded at/above the target —
  //  repeated runs reuse the existing reserves and only re-test the ops)
  const usdcSeed = '15.12', eurcSeed = '14.00';
  const reserveA0 = Number(await pool.reserveA()) / 1e6;
  const reserveB0 = Number(await pool.reserveB()) / 1e6;
  const reserveA_CUM = Number(usdcSeed) + 5.4; // + first partial seed from earlier run
  const reserveB_CUM = Number(eurcSeed) + 5.0;
  let usdcDebit = 0, eurcDebit = 0;
  if (reserveA0 > 1 && reserveB0 > 1) {
    console.log(`[seed] pool already funded (${reserveA0.toFixed(4)} / ${reserveB0.toFixed(4)}) — skipping`);
  } else {
    console.log(`[seed] addLiquidity(${usdcSeed} USDC, ${eurcSeed} EURC) ...`);
  const usdcBefore = await bal(usdc, relayer);
  const eurcBefore = await bal(eurc, relayer);
  const seedTx = await pool.addLiquidity(parseUnits(usdcSeed, 6), parseUnits(eurcSeed, 6));
  const seedReceipt = await seedTx.wait();
  const usdcAfter = await bal(usdc, relayer);
  const eurcAfter = await bal(eurc, relayer);
  const usdcDebitSeed = usdcBefore - usdcAfter;
  const eurcDebitSeed = eurcBefore - eurcAfter;
  usdcDebit = usdcDebitSeed;
  eurcDebit = eurcDebitSeed;
  console.log(`  seed tx ${seedReceipt.hash}`);
  console.log(`  USDC debit ${usdcDebit.toFixed(6)} (asked ${usdcSeed}, fee ${(usdcDebit - Number(usdcSeed)).toFixed(6)})`);
  console.log(`  EURC debit ${eurcDebit.toFixed(6)} (asked ${eurcSeed}, fee ${(eurcDebit - Number(eurcSeed)).toFixed(6)})`);
  ok('seed: USDC debited = asked + sender-side fee', usdcDebit >= Number(usdcSeed) && usdcDebit < Number(usdcSeed) * 1.1, `debit ${usdcDebit.toFixed(6)}`);
  ok('seed: EURC debited exactly (EURC is fee-free)', Math.abs(eurcDebit - Number(eurcSeed)) < 0.000001, `debit ${eurcDebit.toFixed(6)}`);
  const reserveA = Number(await pool.reserveA()) / 1e6;
  const reserveB = Number(await pool.reserveB()) / 1e6;
  const shares = Number(await pool.totalLiquidityShares());
  const reserveA_CUM = Number(usdcSeed) + 5.4; // + first partial seed from earlier run
  const reserveB_CUM = Number(eurcSeed) + 5.0;
  ok('reserves match cumulative seed exactly', Math.abs(reserveA - reserveA_CUM) < 0.000001 && Math.abs(reserveB - reserveB_CUM) < 0.000001,
    `A ${reserveA} / B ${reserveB}`);
  ok('shares minted', shares > 0, `total shares ${shares}`);
  } // end seed if/else

  // ── 1b. USDC EOA->EOA fee schedule probe (sender debit at 3 sizes) ───────
  const probeTarget = new Wallet('0x1111111111111111111111111111111111111111111111111111111111111111', rpc).address;
  const usdcBalNow = await bal(usdc, relayer);
  if (usdcBalNow < 1.6) {
    console.log('[fee] probe skipped — USDC balance too low to run the transfer probe');
  } else {
    console.log('[fee] EOA->EOA USDC transfer fee probe ...');
    for (const size of ['0.05', '0.50', '1.00']) {
      const before = await bal(usdc, relayer);
      const tx = await usdc.transfer(probeTarget, parseUnits(size, 6));
      await tx.wait();
      const after = await bal(usdc, relayer);
      const debit = before - after;
      console.log(`  send ${size} -> debit ${debit.toFixed(6)} (fee ${(debit - Number(size)).toFixed(6)})`);
    }
  }

  // ── 2. USDC -> EURC swap (quote first, 1% slippage) ──────────────────────
  const in1 = '1.00';
  const quote1 = Number(await pool.getQuote(USDC_ADDR, parseUnits(in1, 6))) / 1e6;
  console.log(`[swap] USDC->EURC ${in1} (quote ${quote1.toFixed(6)}) ...`);
  const eurcBeforeSwap = await bal(eurc, relayer);
  const usdcBeforeSwap = await bal(usdc, relayer);
  const swap1Tx = await pool.swap(USDC_ADDR, parseUnits(in1, 6), parseUnits((quote1 * 0.99).toFixed(6), 6));
  const swap1Rec = await swap1Tx.wait();
  const eurcAfterSwap = await bal(eurc, relayer);
  const usdcAfterSwap = await bal(usdc, relayer);
  const eurcGain = eurcAfterSwap - eurcBeforeSwap;
  const usdcSpent = usdcBeforeSwap - usdcAfterSwap;
  console.log(`  swap tx ${swap1Rec.hash}`);
  console.log(`  quote ${quote1.toFixed(6)}, actual in ${usdcSpent.toFixed(6)} / out ${eurcGain.toFixed(6)}`);
  ok('USDC->EURC actual >= 99% of quote', eurcGain >= quote1 * 0.99, `out ${eurcGain.toFixed(6)} vs quote ${quote1.toFixed(6)}`);
  ok('USDC->EURC actual within 2% of quote (fee-adjusted)', Math.abs(eurcGain - quote1) < quote1 * 0.02, `delta ${(eurcGain - quote1).toFixed(6)}`);
  ok('USDC->EURC trader debit matches amountIn (+fee)', usdcSpent >= Number(in1) && usdcSpent < Number(in1) * 1.2,
    `debit ${usdcSpent.toFixed(6)} for ${in1} in`);

  // ── 3. EURC -> USDC swap (quote first) ───────────────────────────────────
  const in2 = '0.50';
  const quote2 = Number(await pool.getQuote(EURC_ADDR, parseUnits(in2, 6))) / 1e6;
  console.log(`[swap] EURC->USDC ${in2} (quote ${quote2.toFixed(6)}) ...`);
  const usdcBeforeSwap2 = await bal(usdc, relayer);
  const eurcBeforeSwap2 = await bal(eurc, relayer);
  const swap2Tx = await pool.swap(EURC_ADDR, parseUnits(in2, 6), parseUnits((quote2 * 0.99).toFixed(6), 6));
  const swap2Rec = await swap2Tx.wait();
  const usdcGain = await bal(usdc, relayer) - usdcBeforeSwap2;
  const eurcSpent = eurcBeforeSwap2 - await bal(eurc, relayer);
  console.log(`  swap tx ${swap2Rec.hash}`);
  console.log(`  quote ${quote2.toFixed(6)}, actual in ${eurcSpent.toFixed(6)} / out ${usdcGain.toFixed(6)}`);
  ok('EURC->USDC actual >= 99% of quote', usdcGain >= quote2 * 0.99, `out ${usdcGain.toFixed(6)} vs quote ${quote2.toFixed(6)}`);
  ok('EURC->USDC actual within 2% of quote', Math.abs(usdcGain - quote2) < quote2 * 0.02, `delta ${(usdcGain - quote2).toFixed(6)}`);
  ok('EURC->USDC trader debit matches amountIn (EURC is fee-free)', Math.abs(eurcSpent - Number(in2)) < 0.0005,
    `debit ${eurcSpent.toFixed(6)} for ${in2} in`);

  // ── 4. second addLiquidity (balanced at current ratio) ───────────────────
  const reserveA2 = Number(await pool.reserveA()) / 1e6;
  const reserveB2 = Number(await pool.reserveB()) / 1e6;
  const usdcAdd = '0.50';
  const eurcAdd = (Number(usdcAdd) * reserveB2 / reserveA2).toFixed(6);
  console.log(`[add] addLiquidity(${usdcAdd} USDC, ${eurcAdd} EURC) at ratio ${(reserveA2 / reserveB2).toFixed(4)} ...`);
  await approve(usdc, usdcAdd);
  await approve(eurc, eurcAdd);
  const sharesBefore = Number(await pool.liquidityShares(relayer));
  const addTx = await pool.addLiquidity(parseUnits(usdcAdd, 6), parseUnits(eurcAdd, 6));
  const addRec = await addTx.wait();
  const sharesAfter = Number(await pool.liquidityShares(relayer));
  console.log(`  add tx ${addRec.hash}, shares ${sharesBefore} -> ${sharesAfter}`);
  ok('second addLiquidity minted shares', sharesAfter > sharesBefore, `+${sharesAfter - sharesBefore}`);

  // ── 5. removeLiquidity round-trip (25% of position) ──────────────────────
  const shareOut = Math.floor((sharesAfter - sharesBefore) * 0.5);
  console.log(`[remove] removeLiquidity(${shareOut} of ${sharesAfter - sharesBefore} new shares) ...`);
  const usdcBeforeRm = await bal(usdc, relayer);
  const eurcBeforeRm = await bal(eurc, relayer);
  const rmTx = await pool.removeLiquidity(shareOut);
  const rmRec = await rmTx.wait();
  const usdcRm = await bal(usdc, relayer) - usdcBeforeRm;
  const eurcRm = await bal(eurc, relayer) - eurcBeforeRm;
  const reserveA3 = Number(await pool.reserveA()) / 1e6;
  const reserveB3 = Number(await pool.reserveB()) / 1e6;
  const expectedA = (shareOut * reserveA3) / Number(await pool.totalLiquidityShares());
  const expectedB = (shareOut * reserveB3) / Number(await pool.totalLiquidityShares());
  console.log(`  rm tx ${rmRec.hash}, got ${usdcRm.toFixed(6)} USDC + ${eurcRm.toFixed(6)} EURC`);
  console.log(`  expected ${expectedA.toFixed(6)} USDC + ${expectedB.toFixed(6)} EURC`);
  ok('removeLiquidity payout proportional to reserves (USDC leg within USDC outbound fee)',
    Math.abs(usdcRm - expectedA) < 0.003 && Math.abs(eurcRm - expectedB) < 0.000001,
    `A ${usdcRm.toFixed(6)}/${expectedA.toFixed(6)}, B ${eurcRm.toFixed(6)}/${expectedB.toFixed(6)}`);
  ok('removeLiquidity reduced position', Number(await pool.liquidityShares(relayer)) < sharesAfter, `shares ${Number(await pool.liquidityShares(relayer))}`);

  // ── fee summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log('Fee summary (measured):');
  if (usdcDebit > 0) {
    console.log(`  seed USDC debit ${usdcDebit.toFixed(6)} vs ${usdcSeed} asked → fee ${(usdcDebit - Number(usdcSeed)).toFixed(6)}`);
    console.log(`  seed EURC debit ${eurcDebit.toFixed(6)} vs ${eurcSeed} asked → fee ${(eurcDebit - Number(eurcSeed)).toFixed(6)}`);
  } else {
    console.log(`  seed skipped (pool already funded); prior run measured USDC inbound fees 0.0025–0.0044`);
  }
  console.log(`  swap1 USDC->EURC: debit ${usdcSpent.toFixed(6)} (in ${in1}), out ${eurcGain.toFixed(6)} vs quote ${quote1.toFixed(6)}`);
  console.log(`  swap2 EURC->USDC: debit ${eurcSpent.toFixed(6)} (in ${in2}), out ${usdcGain.toFixed(6)} vs quote ${quote2.toFixed(6)}`);
  console.log(`  removeLiquidity got ${usdcRm.toFixed(6)} USDC + ${eurcRm.toFixed(6)} EURC for ${shareOut} shares`);
  console.log(`  final reserves ${reserveA3.toFixed(4)} A / ${reserveB3.toFixed(4)} B`);

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('e2e threw:', e?.message ?? e);
  process.exit(1);
});
