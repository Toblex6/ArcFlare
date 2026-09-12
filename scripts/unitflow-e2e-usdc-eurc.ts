// scripts/unitflow-e2e-usdc-eurc.ts
//
// UnitFlow Phase 2 live testnet E2E — the missing execution direction:
//
//   USDC (native, payer) -> [WUSDC.deposit wrap] -> UniversalRouter
//   execute(0x00 V3_SWAP_EXACT_IN, WUSDC->EURC fee 100, payerIsUser=true)
//   -> EURC directly to merchant
//
// Tiny amount (0.01 USDC). Same controlled wallets as Gate C:
// payer/signer = relayer 0x0d9Dc173… (RELAYER_PRIVATE_KEY), merchant =
// seller 0xc119bb61… (no key needed — recipient never signs).
//
// Flow: quote (inside build) -> approvals -> wrap -> execute -> receipt ->
// evidence -> verifyUnitFlowExecution(). No assertion that the router holds
// absolute-zero balances (residuals are recorded, not assumed).
//
// Run:  npx tsx scripts/unitflow-e2e-usdc-eurc.ts
// Needs: ARC_TESTNET_RPC, RELAYER_PRIVATE_KEY, SELLER_ADDRESS (merchant)

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildUnitFlowV3Execution } from '@/src/lib/routing/providers/unitflowV3';
import { verifyUnitFlowExecution } from '@/src/lib/routing/providers/unitflowV3';

const CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
} as const;

const USDC_IFACE = '0x3600000000000000000000000000000000000000' as const;
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const;

const ERC20_READ_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

async function withRpc<T>(label: string, fn: (rpc: string) => Promise<T>): Promise<T> {
  const rpcs = [
    process.env.ARC_TESTNET_RPC,
    'https://rpc.testnet.arc.network',
    'https://rpc.testnet.arc.io',
    'https://rpc.blockdaemon.testnet.arc.io',
    'https://rpc.drpc.testnet.arc.io',
  ].filter(Boolean) as string[];
  let last: unknown = null;
  for (const rpc of [...new Set(rpcs)]) {
    try {
      return await fn(rpc);
    } catch (e) {
      last = e;
      console.log(`  [rpc retry] ${label} failed on ${rpc}: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
}

async function main() {
  const rpc = (process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.network').trim();
  const pk = (process.env.RELAYER_PRIVATE_KEY ?? '').trim();
  if (!pk) throw new Error('RELAYER_PRIVATE_KEY missing');
  const merchant = (process.env.SELLER_ADDRESS ?? '').trim() as Hex;
  if (!/^0x[a-fA-F0-9]{40}$/.test(merchant)) throw new Error('SELLER_ADDRESS missing/malformed');

  const account = privateKeyToAccount(pk as Hex);
  const payer = account.address;
  console.log(`payer/signer : ${payer}`);
  console.log(`merchant     : ${merchant}`);

  const publicClient: any = createPublicClient({ chain: CHAIN as any, transport: http(rpc, { timeout: 30_000 }) });
  const walletClient: any = createWalletClient({ account, chain: CHAIN as any, transport: http(rpc, { timeout: 30_000 }) });

  const bal = (token: Hex, who: Hex) =>
    withRpc(`balanceOf ${token.slice(0, 8)}`, async (r) => {
      const c: any = createPublicClient({ chain: CHAIN as any, transport: http(r, { timeout: 20_000 }) });
      return (await c.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [who] })) as bigint;
    });
  const nat = (who: Hex) => withRpc('getBalance', async (r) => {
    const c: any = createPublicClient({ chain: CHAIN as any, transport: http(r, { timeout: 20_000 }) });
    return (await c.getBalance({ address: who })) as bigint;
  });

  // ── 1. build (live quote + pool validation inside) ─────────────────────────
  const INPUT_CANONICAL = 10_000n; // 0.01 USDC
  console.log('\n[1] buildUnitFlowV3Execution({ USDC -> EURC, 0.01 }) ...');
  const env = await buildUnitFlowV3Execution({
    inputSymbol: 'USDC',
    outputSymbol: 'EURC',
    inputAmount: INPUT_CANONICAL,
    merchantSCA: merchant,
    expectedPayer: payer,
  });
  console.log(`  venue=${env.venueId} phase=${(env as any).phase}`);
  console.log(`  deployment router=${env.deployment.universalRouter}`);
  console.log(`  pool=${env.pool} fee=${env.fee}`);
  console.log(`  inputCanonical=${env.inputAmountCanonical} amountInSwap=${env.amountInSwap}`);
  console.log(`  quotedOutputSwap=${env.quotedOutputSwap} minOutSwap=${env.minOutSwap} slippageBps=${env.slippageBps}`);
  console.log(`  commands=${env.commands} deadline=${env.deadline} expiresAt=${env.expiresAtSec}`);
  console.log(`  executionIdentity=${env.executionIdentity}`);
  console.log(`  wrapTx: to=${env.wrapTx?.to} value=${env.wrapTx?.value}`);
  console.log(`  swapTx: to=${env.swapTx.to} value=${env.swapTx.value} dataLen=${env.swapTx.data.length}`);
  env.approvals.forEach((a, i) => console.log(`  approval[${i}] ${a.label}: to=${a.to} dataLen=${a.data.length}`));
  const WUSDC = env.deployment.wusdc as Hex;

  // ── 2. balances before ─────────────────────────────────────────────────────
  console.log('\n[2] balances BEFORE ...');
  const b4 = {
    signerNative: await nat(payer),
    signerIface: await bal(USDC_IFACE, payer),
    signerWusdc: await bal(WUSDC, payer),
    signerEurc: await bal(EURC, payer),
    merchEurc: await bal(EURC, merchant),
    merchWusdc: await bal(WUSDC, merchant),
    routerWusdc: await bal(WUSDC, env.deployment.universalRouter as Hex),
    routerEurc: await bal(EURC, env.deployment.universalRouter as Hex),
  };
  console.log(`  signer native(18dec)=${b4.signerNative} iface(6dec)=${b4.signerIface} WUSDC=${b4.signerWusdc} EURC=${b4.signerEurc}`);
  console.log(`  merchant EURC=${b4.merchEurc} WUSDC=${b4.merchWusdc}`);
  console.log(`  router WUSDC=${b4.routerWusdc} EURC=${b4.routerEurc}`);

  const send = async (label: string, to: Hex, data: Hex, value: bigint): Promise<Hex> => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const hash = (await walletClient.sendTransaction({ to, data, value })) as Hex;
        console.log(`  ${label} sent: ${hash} (attempt ${attempt})`);
        const rcpt: any = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        console.log(`  ${label} mined: status=${rcpt.status} block=${rcpt.blockNumber}`);
        if (rcpt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
        return hash;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (attempt === 4) throw e;
        console.log(`  ${label} attempt ${attempt} failed, retrying: ${msg.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error('unreachable');
  };

  // ── 3. wrap (only for USDC input) ──────────────────────────────────────────
  console.log('\n[3] input-asset conversion (WUSDC.deposit) ...');
  let wrapHash: Hex | undefined;
  if (env.wrapTx) {
    wrapHash = await send('wrap', env.wrapTx.to as Hex, env.wrapTx.data, env.wrapTx.value);
  }

  // ── 4. approvals ───────────────────────────────────────────────────────────
  console.log('\n[4] required approvals ...');
  const approvalHashes: Hex[] = [];
  for (const a of env.approvals) {
    approvalHashes.push(await send(a.label, a.to as Hex, a.data, a.value));
  }

  // ── 5. execute ─────────────────────────────────────────────────────────────
  console.log('\n[5] UniversalRouter execute() ...');
  const execHash = await send('execute', env.swapTx.to as Hex, env.swapTx.data, env.swapTx.value);

  // ── 6. evidence + verification ─────────────────────────────────────────────
  console.log('\n[6] collect evidence + verify ...');
  const rcpt: any = await withRpc('receipt', async (r) => {
    const c: any = createPublicClient({ chain: CHAIN as any, transport: http(r, { timeout: 20_000 }) });
    return c.getTransactionReceipt({ hash: execHash });
  });
  const tx: any = await withRpc('tx', async (r) => {
    const c: any = createPublicClient({ chain: CHAIN as any, transport: http(r, { timeout: 20_000 }) });
    return c.getTransaction({ hash: execHash });
  });
  const block: any = await withRpc('block', async (r) => {
    const c: any = createPublicClient({ chain: CHAIN as any, transport: http(r, { timeout: 20_000 }) });
    return c.getBlock({ blockNumber: rcpt.blockNumber });
  });
  const after = {
    signerNative: await nat(payer),
    signerIface: await bal(USDC_IFACE, payer),
    signerWusdc: await bal(WUSDC, payer),
    signerEurc: await bal(EURC, payer),
    merchEurc: await bal(EURC, merchant),
    merchWusdc: await bal(WUSDC, merchant),
    routerWusdc: await bal(WUSDC, env.deployment.universalRouter as Hex),
    routerEurc: await bal(EURC, env.deployment.universalRouter as Hex),
  };
  console.log(`  signer native=${after.signerNative} (dNative=${after.signerNative - b4.signerNative})`);
  console.log(`  signer WUSDC=${after.signerWusdc} (was ${b4.signerWusdc})`);
  console.log(`  merchant EURC=${after.merchEurc} (was ${b4.merchEurc}, delta=${after.merchEurc - b4.merchEurc})`);
  console.log(`  router WUSDC=${after.routerWusdc} (was ${b4.routerWusdc}) EURC=${after.routerEurc} (was ${b4.routerEurc})`);
  console.log(`  receipt status=${rcpt.status} block=${rcpt.blockNumber} txTimestamp=${block.timestamp}`);

  const verified = verifyUnitFlowExecution({
    deployment: env.deployment,
    txHash: execHash,
    to: tx.to,
    value: tx.value,
    commands: env.commands,
    inputs: [...env.inputs],
    deadline: env.deadline,
    payer: tx.from,
    expectedPayer: payer,
    merchantSCA: merchant,
    tokenInSwap: env.tokenInSwap,
    tokenOutSwap: env.tokenOutSwap,
    amountInSwap: env.amountInSwap,
    minOutSwap: env.minOutSwap,
    fee: env.fee,
    pool: env.pool,
    expiresAtSec: env.expiresAtSec,
    txTimestampSec: Number(block.timestamp),
    merchantBalanceBefore: b4.merchEurc,
    merchantBalanceAfter: after.merchEurc,
  });
  console.log('\n[7] verifyUnitFlowExecution RESULT: PASS');
  console.log(`  executionTxHash=${verified.executionTxHash}`);
  console.log(`  router=${verified.router} payer=${verified.payer} recipient=${verified.recipient}`);
  console.log(`  inputToken=${verified.inputToken} inputAmount=${verified.inputAmount}`);
  console.log(`  outputToken=${verified.outputToken} actualOutput=${verified.actualOutput} minOut=${verified.minOut}`);
  console.log(`  fee=${verified.fee} pool=${verified.pool}`);

  console.log('\n── E2E EVIDENCE SUMMARY ──');
  console.log(`  quote: in=${env.inputAmountCanonical} (canonical) quoted=${env.quotedOutputSwap} minOut=${env.minOutSwap}`);
  console.log(`  pool=${env.pool} fee=${env.fee} amountInSwap=${env.amountInSwap}`);
  console.log(`  wrapHash=${wrapHash ?? '(n/a)'}`);
  console.log(`  approvalHashes=${approvalHashes.join(',')}`);
  console.log(`  execHash=${execHash} status=${rcpt.status}`);
  console.log('\nE2E PASS');
}

main().catch((e) => { console.error('e2e threw:', (e as Error)?.message ?? e); process.exit(1); });
