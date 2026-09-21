// scripts/bridge-completion-integrity-tests.ts
//
// Bridge completion integrity (H1/M3 audit fix): pure, DB-free, RPC-free
// proof that the exploit path is closed without breaking the legitimate
// flow. Exercises the pure receipt-analysis helpers in
// src/lib/bridge/externalVerify.ts with synthetic logs encoded through the
// SAME V2 ABI constants production uses:
//
//   Burn binding (extractBurnBinding):
//     B1 valid V2 burn -> ok + the exact bytes32 message nonce
//     B2 transfer-only receipt (no CCTP events) -> BINDING_MISMATCH, no
//        BURN_CONFIRMED (M3: undecodable burns fail closed)
//     B3 DepositForBurn naming a different recipient -> BINDING_MISMATCH
//     B4 burn without MessageSent -> BINDING_MISMATCH
//     B5 legacy V1-shaped DepositForBurn -> BINDING_MISMATCH (the old ABI
//        never decoded a real V2 burn; unknown shapes fail closed)
//   Mint binding (analyzeMintReceipt), production pattern 300000 requested
//   / 276074 credited (23926 relayer fee):
//     M1 dust Transfer (1 wei), no bridge message -> NONCE_MISMATCH (the H1
//        exploit: amount > 0 alone never completes)
//     M2 full-amount Transfer but wrong-nonce MessageReceived ->
//        NONCE_MISMATCH (unrelated transaction rejected)
//     M3 Transfer == raw requested (300000) with matching nonce but
//        MintAndWithdraw(net 276074, fee 23926) -> AMOUNT_MISMATCH (proves
//        completion validates expected-minus-fee, not raw equality)
//     M4 production pattern: matching nonce + MintAndWithdraw(276074,
//        fee 23926) + Transfer 276074 -> ok, actualAmount 276074
//     M5 matching nonce + credit but no MintAndWithdraw -> AMOUNT_MISMATCH
//     M6 legacy row (expectedNonce null) -> NONCE_MISMATCH, never a pass
//     M7 MintAndWithdraw gross (net + fee) != requested -> AMOUNT_MISMATCH
//
// Run: npx tsx scripts/bridge-completion-integrity-tests.ts

import { encodeEventTopics, encodeAbiParameters, pad, type Hex } from 'viem';
import {
  ERC20_TRANSFER_ABI,
  DEPOSIT_FOR_BURN_V2_ABI,
  MESSAGE_SENT_ABI,
  MESSAGE_RECEIVED_V2_ABI,
  MINT_AND_WITHDRAW_V2_ABI,
  extractBurnBinding,
  analyzeMintReceipt,
  type ReceiptLog,
} from '@/lib/bridge/externalVerify';

const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x) as unknown)?.slice(0, 200) ?? '';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

// ─── Fixture addresses / amounts ────────────────────────────────────────────
const SRC_TM = '0x1111111111111111111111111111111111111111';
const SRC_MT = '0x2222222222222222222222222222222222222222';
const ARC_TM = '0x3333333333333333333333333333333333333333';
const ARC_MT = '0x4444444444444444444444444444444444444444';
const USDC_SRC = '0x5555555555555555555555555555555555555555';
const USDC_ARC = '0x6666666666666666666666666666666666666666';
const USER = '0x7777777777777777777777777777777777777777';
const DEST = '0x8888888888888888888888888888888888888888';
const FORWARDER = '0x9999999999999999999999999999999999999999';

const REQUESTED = 300_000n; // production: 0.30 USDC requested
const FEE = 23_926n;        // production: relayer fee observed
const NET = 276_074n;       // production: credited
// Production-style bytes32 message nonce (0xc6dd3c88… prefix).
const NONCE = ('0xc6dd3c88' + '11'.repeat(28)) as Hex;
const WRONG_NONCE = ('0xdeadbeef' + '22'.repeat(28)) as Hex;

// ─── CCTP V2 wire-format builders (layouts from evm-cctp-contracts) ─────────
const u32h = (n: number) => n.toString(16).padStart(8, '0');
const u256h = (n: bigint) => n.toString(16).padStart(64, '0');
const b32 = (addr: string) => addr.toLowerCase().replace('0x', '').padStart(64, '0');

function burnBody(o: { burnToken: string; mintRecipient: string; amount: bigint; sender: string; maxFee: bigint; feeExecuted: bigint }): Hex {
  return ('0x' + '00000001' + b32(o.burnToken) + b32(o.mintRecipient) + u256h(o.amount) + b32(o.sender) + u256h(o.maxFee) + u256h(o.feeExecuted) + u256h(0n)) as Hex;
}

function cctpMessage(o: { src: number; dst: number; nonce: Hex; sender: string; recipient: string; caller: string; minFT: number; ftExec: number; body: Hex }): Hex {
  return ('0x' + '00000002' + u32h(o.src) + u32h(o.dst) + o.nonce.replace('0x', '') + b32(o.sender) + b32(o.recipient) + b32(o.caller) + u32h(o.minFT) + u32h(o.ftExec) + o.body.replace('0x', '')) as Hex;
}

function toLog(address: string, enc: { topics: readonly Hex[]; data: Hex }): ReceiptLog {
  return { address, data: enc.data, topics: [...enc.topics] as Hex[] };
}

// viem 2.x builds event logs from topics + ABI-encoded data (no
// encodeEventLog root export): topics carry the indexed params, data the
// rest in declaration order.
function encodeLog(o: { abi: readonly unknown[]; eventName: string; args: Record<string, unknown> }): { topics: Hex[]; data: Hex } {
  const { abi, eventName, args } = o;
  const entry = (abi as Array<{ type: string; name: string; inputs: Array<{ name: string; type: string; indexed?: boolean }> }>).find(
    (e) => e.type === 'event' && e.name === eventName
  )!;
  const topics = encodeEventTopics({ abi: abi as any, eventName: eventName as any, args: args as any }) as Hex[];
  const dataInputs = entry.inputs.filter((i) => !i.indexed);
  const dataValues = dataInputs.map((i) => args[i.name]);
  const data = encodeAbiParameters(dataInputs as any, dataValues as any) as Hex;
  return { topics, data };
}

const DEPOSIT_FOR_BURN_V1_ABI = [
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'nonce', type: 'uint64', indexed: true },
      { name: 'burnToken', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: false },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'address', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
    ],
  },
] as const;

const burnCtx = {
  usdcAddress: USDC_SRC,
  tokenMessenger: SRC_TM,
  messageTransmitter: SRC_MT,
  sourceAddress: USER,
  amountBaseUnits: REQUESTED,
  destination: DEST,
  arcDomain: 26,
  arcTokenMessenger: ARC_TM,
};

const mintCtxBase = {
  usdcAddress: USDC_ARC,
  messageTransmitter: ARC_MT,
  tokenMessenger: ARC_TM,
  destination: DEST,
  expectedAmount: REQUESTED,
  expectedSourceDomain: 6,
  expectedSender: pad(SRC_TM as Hex, { size: 32 }),
};

function validBurnLogs(recipient: string = DEST): ReceiptLog[] {
  const body = burnBody({ burnToken: USDC_SRC, mintRecipient: recipient, amount: REQUESTED, sender: USER, maxFee: 30000n, feeExecuted: 0n });
  const message = cctpMessage({ src: 6, dst: 26, nonce: NONCE, sender: SRC_TM, recipient: ARC_TM, caller: FORWARDER, minFT: 1000, ftExec: 1000, body });
  return [
    toLog(SRC_TM, encodeLog({
      abi: DEPOSIT_FOR_BURN_V2_ABI, eventName: 'DepositForBurn',
      args: {
        burnToken: USDC_SRC as Hex, amount: REQUESTED, depositor: USER as Hex,
        mintRecipient: pad(recipient as Hex, { size: 32 }), destinationDomain: 26,
        destinationTokenMessenger: pad(ARC_TM as Hex, { size: 32 }),
        destinationCaller: pad(FORWARDER as Hex, { size: 32 }),
        maxFee: 30000n, minFinalityThreshold: 1000, hookData: '0x' as Hex,
      },
    })),
    toLog(SRC_MT, encodeLog({ abi: MESSAGE_SENT_ABI, eventName: 'MessageSent', args: { message } })),
  ];
}

function productionMintLogs(): ReceiptLog[] {
  const body = burnBody({ burnToken: USDC_SRC, mintRecipient: DEST, amount: REQUESTED, sender: USER, maxFee: 30000n, feeExecuted: FEE });
  return [
    toLog(ARC_MT, encodeLog({
      abi: MESSAGE_RECEIVED_V2_ABI, eventName: 'MessageReceived',
      args: {
        caller: FORWARDER as Hex, sourceDomain: 6, nonce: NONCE,
        sender: pad(SRC_TM as Hex, { size: 32 }), finalityThresholdExecuted: 1000, messageBody: body,
      },
    })),
    toLog(ARC_TM, encodeLog({
      abi: MINT_AND_WITHDRAW_V2_ABI, eventName: 'MintAndWithdraw',
      args: { mintRecipient: DEST as Hex, amount: NET, mintToken: USDC_ARC as Hex, feeCollected: FEE },
    })),
    toLog(USDC_ARC, encodeLog({
      abi: ERC20_TRANSFER_ABI, eventName: 'Transfer',
      args: { from: ARC_TM as Hex, to: DEST as Hex, value: NET },
    })),
  ];
}

function main() {
  // ── Burn binding ─────────────────────────────────────────────────────────
  const b1 = extractBurnBinding(validBurnLogs(), burnCtx);
  ok('B1 valid V2 burn binds + yields the message nonce', b1.ok === true && b1.ok && b1.cctpNonce === NONCE.toLowerCase(), show(b1));

  const transferOnly = [
    toLog(USDC_SRC, encodeLog({
      abi: ERC20_TRANSFER_ABI, eventName: 'Transfer',
      args: { from: USER as Hex, to: SRC_TM as Hex, value: REQUESTED },
    })),
  ];
  const b2 = extractBurnBinding(transferOnly, burnCtx);
  ok('B2 transfer-only receipt fails closed (no BURN_CONFIRMED)', !b2.ok && (b2 as any).reason === 'BINDING_MISMATCH', show(b2));

  const b3 = extractBurnBinding(validBurnLogs('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), burnCtx);
  ok('B3 burn naming a different recipient is proof against', !b3.ok && (b3 as any).reason === 'BINDING_MISMATCH', show(b3));

  const b4logs = validBurnLogs().filter((l) => l.address !== SRC_MT);
  const b4 = extractBurnBinding(b4logs, burnCtx);
  ok('B4 burn without MessageSent fails closed', !b4.ok && (b4 as any).reason === 'BINDING_MISMATCH', show(b4));

  const v1burn = toLog(SRC_TM, encodeLog({
    abi: DEPOSIT_FOR_BURN_V1_ABI, eventName: 'DepositForBurn',
    args: {
      nonce: 12345n, burnToken: USDC_SRC as Hex, amount: REQUESTED, depositor: USER as Hex,
      mintRecipient: pad(DEST as Hex, { size: 32 }), destinationDomain: 26,
      destinationTokenMessenger: SRC_TM as Hex, destinationCaller: pad('0x0000000000000000000000000000000000000000' as Hex, { size: 32 }),
    },
  }));
  const b5 = extractBurnBinding([v1burn], burnCtx);
  ok('B5 legacy V1-shaped burn event fails closed', !b5.ok && (b5 as any).reason === 'BINDING_MISMATCH', show(b5));

  // ── Mint binding ─────────────────────────────────────────────────────────
  const dust = [
    toLog(USDC_ARC, encodeLog({
      abi: ERC20_TRANSFER_ABI, eventName: 'Transfer',
      args: { from: USER as Hex, to: DEST as Hex, value: 1n },
    })),
  ];
  const m1 = analyzeMintReceipt(dust, { ...mintCtxBase, expectedNonce: NONCE });
  ok('M1 dust transfer (1 wei, no message) REJECTED as completion', !m1.ok && (m1 as any).reason === 'NONCE_MISMATCH', show(m1));

  const wrongNonceLogs = productionMintLogs().map((l) => {
    if (l.address !== ARC_MT) return l;
    const body = burnBody({ burnToken: USDC_SRC, mintRecipient: DEST, amount: REQUESTED, sender: USER, maxFee: 30000n, feeExecuted: FEE });
    return toLog(ARC_MT, encodeLog({
      abi: MESSAGE_RECEIVED_V2_ABI, eventName: 'MessageReceived',
      args: {
        caller: FORWARDER as Hex, sourceDomain: 6, nonce: WRONG_NONCE,
        sender: pad(SRC_TM as Hex, { size: 32 }), finalityThresholdExecuted: 1000, messageBody: body,
      },
    }));
  });
  const m2 = analyzeMintReceipt(wrongNonceLogs, { ...mintCtxBase, expectedNonce: NONCE });
  ok('M2 unrelated mint (wrong nonce, full credit) REJECTED', !m2.ok && (m2 as any).reason === 'NONCE_MISMATCH', show(m2));

  const rawEqualityLogs = productionMintLogs().map((l) => {
    if (l.address !== USDC_ARC) return l;
    return toLog(USDC_ARC, encodeLog({
      abi: ERC20_TRANSFER_ABI, eventName: 'Transfer',
      args: { from: ARC_TM as Hex, to: DEST as Hex, value: REQUESTED },
    }));
  });
  const m3 = analyzeMintReceipt(rawEqualityLogs, { ...mintCtxBase, expectedNonce: NONCE });
  ok('M3 raw-equality credit (300000, ignoring fee) REJECTED', !m3.ok && (m3 as any).reason === 'AMOUNT_MISMATCH', show(m3));

  const m4 = analyzeMintReceipt(productionMintLogs(), { ...mintCtxBase, expectedNonce: NONCE });
  ok('M4 production pattern (nonce + 276074 net of 300000) COMPLETES', m4.ok === true && m4.ok && m4.actualAmount === NET, JSON.stringify(m4, (_, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 120));

  const noMawLogs = productionMintLogs().filter((l) => l.address !== ARC_TM);
  const m5 = analyzeMintReceipt(noMawLogs, { ...mintCtxBase, expectedNonce: NONCE });
  ok('M5 mint without MintAndWithdraw REJECTED', !m5.ok && (m5 as any).reason === 'AMOUNT_MISMATCH', show(m5));

  const m6 = analyzeMintReceipt(productionMintLogs(), { ...mintCtxBase, expectedNonce: null });
  ok('M6 legacy row without recorded nonce never completes', !m6.ok && (m6 as any).reason === 'NONCE_MISMATCH', show(m6));

  const grossMismatchLogs = productionMintLogs().map((l) => {
    if (l.address !== ARC_TM) return l;
    return toLog(ARC_TM, encodeLog({
      abi: MINT_AND_WITHDRAW_V2_ABI, eventName: 'MintAndWithdraw',
      args: { mintRecipient: DEST as Hex, amount: NET, mintToken: USDC_ARC as Hex, feeCollected: 0n },
    }));
  });
  const m7 = analyzeMintReceipt(grossMismatchLogs, { ...mintCtxBase, expectedNonce: NONCE });
  ok('M7 mint gross (net + fee) != requested REJECTED', !m7.ok && (m7 as any).reason === 'AMOUNT_MISMATCH', show(m7));

  console.log(`\nbridge-completion-integrity-tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
