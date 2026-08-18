// scripts/repro-balance-views.mjs
//
// Deliberate reproduction of the "native-value-send vs ERC20-view divergence"
// observed 2026-08-18 (relayer EOA showed getBalance() differing from
// balanceOf(0x3600...) by ~0.31 USDC at various points).
//
// Arc chain fact (docs.arc.io): native USDC and the ERC-20 interface at
// 0x3600000000000000000000000000000000000000 are ONE asset, two decimal views
// (18 native vs 6 ERC-20). balanceOf() TRUNCATES sub-1e-6 dust. So the only
// legal same-block difference is < 1 micro-USDC.
//
// This script verifies, with FIXED-BLOCK reads (never "latest" at different
// times):
//   A. one-asset relationship: |native(18dec) - balanceOf(6dec)*1e12| < 1e6 wei
//   B. a native value-send: sender debit / receiver credit on BOTH views
//   C. an ERC-20 transfer: same measurements
//   D. EIP-7708: native sends emit a system Transfer log (18 decimals)
//   E. fee per op type (sender-side debit vs amount, receiver credit)
//
// Run: node scripts/repro-balance-views.mjs [rpcUrl]

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { ethers } from 'ethers';

const RPC = process.argv[2] || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const SYS_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';

const provider = new ethers.JsonRpcProvider(RPC);
{
  const origSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    for (let attempt = 1; ; attempt++) {
      try { return await origSend(method, params); }
      catch (e) {
        const msg = String(e?.message ?? e);
        const infoCode = String(e?.info?.error?.code ?? e?.error?.code ?? '');
        const retriable = msg.includes('limit reached') || msg.includes('ECONNRESET') ||
          msg.includes('TIMEOUT') || msg.includes('bad record mac') || msg.includes('request timeout') ||
          msg.includes('connection') || msg.includes('socket') || infoCode.includes('-32011') ||
          infoCode.includes('-32005') || infoCode.includes('429');
        if (!retriable || attempt >= 6) throw e;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  };
}

const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY || '', provider);
const seller = new ethers.Wallet(process.env.SELLER_PRIVATE_KEY || '', provider);
const usdc = new ethers.Contract(USDC, [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
], provider);

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const MICRO = 1_000_000_000_000n; // 1e12 wei = 1e-6 USDC at 18 dec (ERC20-view truncation bound)

async function dualView(addr, blockTag) {
  // same block, both views: native 18-dec wei vs ERC20 6-dec units
  const native = await provider.getBalance(addr, blockTag);          // 18 dec
  const erc20 = await usdc.balanceOf(addr, { blockTag });            // 6 dec
  return { native, erc20 };
}

function usd(n) { return ethers.formatEther(n); }

async function main() {
  console.log(`RPC     : ${RPC}`);
  console.log(`Sender  : seller ${seller.address}`);
  console.log('');

  // ── A. one-asset relationship at fixed block ────────────────────────────
  const block = await provider.getBlockNumber();
  console.log(`[A] same-block dual-view (block ${block}):`);
  for (const [label, addr] of [['relayer', relayer.address], ['seller', seller.address],
    ['probe 0x1111…', '0x1111111111111111111111111111111111111111'],
    ['pool    ', process.env.SWAP_POOL_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000']]) {
    const { native, erc20 } = await dualView(addr, block);
    const expected = erc20 * 1_000_000_000_000n; // 6dec -> 18dec wei
    const diff = native >= expected ? native - expected : expected - native;
    const dust = diff > 0n ? usd(diff) : '0';
    ok(`views agree at same block (${label})`, diff < MICRO,
      `native ${usd(native)} vs erc20 ${ethers.formatUnits(erc20, 6)} (diff ${dust} — truncation allowed < 1e-6)`);
  }

  // ── B/C. controlled sends: native value-send vs ERC-20 transfer ─────────
  const recipient = ethers.Wallet.createRandom();
  const R = recipient.address;

  async function measure(opLabel, sendFn, recipientAddr) {
    const b1 = await provider.getBlockNumber();
    const before = await dualView(seller.address, b1);
    const beforeR = await dualView(recipientAddr, b1);
    const tx = await sendFn();
    const rec = await tx.wait();
    const b2 = rec.blockNumber;
    const after = await dualView(seller.address, b2);
    const afterR = await dualView(recipientAddr, b2);
    const debitNat = before.native - after.native;            // includes gas for native send
    const debitErc = before.erc20 - after.erc20;              // sender-side, 6 dec
    const creditNat = afterR.native - beforeR.native;
    const creditErc = afterR.erc20 - beforeR.erc20;
    console.log(`\n[${opLabel}] tx ${rec.hash} (block ${b2})`);
    console.log(`  sender  native debit ${usd(debitNat)} / erc20 debit ${ethers.formatUnits(debitErc, 6)}`);
    console.log(`  recv    native credit ${usd(creditNat)} / erc20 credit ${ethers.formatUnits(creditErc, 6)}`);
    return { rec, debitNat, debitErc, creditNat, creditErc };
  }

  const AMT = 1_000_000n; // 1.00 USDC (6 dec)
  console.log('\n[B] native value-send 1.00 USDC (seller -> fresh EOA):');
  const nativeRes = await measure('B', () =>
    seller.sendTransaction({ to: R, value: ethers.parseEther('1.0') }), R);
  // receiver credit must be exactly 1.00 on the erc20 view (fee is sender-side if any)
  ok('B: receiver erc20 credit == 1.00 exactly', nativeRes.creditErc === AMT,
    `credit ${ethers.formatUnits(nativeRes.creditErc, 6)}`);
  ok('B: receiver native credit == 1.00 exactly (same asset)', nativeRes.creditNat === ethers.parseEther('1.0'),
    `credit ${usd(nativeRes.creditNat)}`);
  const gasPaid = nativeRes.debitNat - ethers.parseEther('1.0');
  ok('B: sender cost == 1.00 + gas only (NO transfer fee on native sends)',
    gasPaid > 0n && gasPaid < ethers.parseEther('0.01'),
    `gas ${usd(gasPaid)} (erc20-view debit ${ethers.formatUnits(nativeRes.debitErc, 6)})`);
  ok('B: erc20-view sender debit == native debit within truncation (same asset)',
    nativeRes.debitNat - nativeRes.debitErc * 1_000_000_000_000n < MICRO,
    `erc20 debit ${ethers.formatUnits(nativeRes.debitErc, 6)}`);

  // EIP-7708: native send must emit system Transfer log (18 dec) from 0xff..fe
  const sysLog = nativeRes.rec.logs.find((l) => l.address.toLowerCase() === SYS_EMITTER);
  ok('B: EIP-7708 system Transfer log emitted (18-dec native send)',
    !!sysLog && BigInt(sysLog.data) === ethers.parseEther('1.0'),
    sysLog ? `value ${ethers.formatEther(BigInt(sysLog.data))}` : 'no log');

  const recipient2 = ethers.Wallet.createRandom();
  const R2 = recipient2.address;
  console.log('\n[C] ERC-20 transfer 1.00 USDC (seller -> fresh EOA):');
  const ercRes = await measure('C', () =>
    new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)'], seller)
      .transfer(R2, AMT), R2);
  ok('C: receiver erc20 credit == 1.00 exactly', ercRes.creditErc === AMT,
    `credit ${ethers.formatUnits(ercRes.creditErc, 6)}`);
  ok('C: receiver native credit == 1.00 exactly (same asset)', ercRes.creditNat === ethers.parseEther('1.0'),
    `credit ${usd(ercRes.creditNat)}`);
  const ercFee = ercRes.debitErc - AMT;
  console.log(`  -> ERC-20 transfer sender-side fee: ${ethers.formatUnits(ercFee, 6)} USDC (per-target: 0x1111... measured 0.001028, fresh EOA 0.001713)`);
  ok('C: ERC-20 transfer charged a sender-side fee (> 0, no gas in erc20 view)', ercFee > 0n,
    `fee ${ethers.formatUnits(ercFee, 6)}`);
  ok('C: native debit == erc20 debit within truncation (both views move the same asset incl. gas)',
    (ercRes.debitNat > ercRes.debitErc * 1_000_000_000_000n
      ? ercRes.debitNat - ercRes.debitErc * 1_000_000_000_000n
      : ercRes.debitErc * 1_000_000_000_000n - ercRes.debitNat) < MICRO,
    `native ${usd(ercRes.debitNat)} vs erc20 ${ethers.formatUnits(ercRes.debitErc, 6)}`);
  ok('C: sender native debit == 1.00 + fee + gas (same asset, both views move)',
    ercRes.debitNat > ethers.parseEther('1.0') && ercRes.debitNat < ethers.parseEther('1.02'),
    `native debit ${usd(ercRes.debitNat)}`);

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('repro threw:', e?.message ?? e); process.exit(1); });