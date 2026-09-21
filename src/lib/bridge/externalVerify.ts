// src/lib/bridge/externalVerify.ts
//
// SERVER-ONLY verification for EXTERNAL (browser-signed) bridges.
//
// The browser wallet signs the source-chain approve/burn via Circle
// BridgeKit; the server never signs and never broadcasts. These helpers
// prove, from authoritative on-chain receipts, that:
//
//   burn   (verifyExternalBurn):
//     1. the burn tx mined SUCCESSFULLY on the expected source chain,
//     2. it was sent FROM the session's EXTERNAL wallet (no arbitrary hash),
//     3. canonical source-chain USDC debited that wallet for EXACTLY the
//        intent amount (Transfer sum, bigint compare — no floats),
//     4. (strict, fail-closed) the receipt carries a decodable CCTP V2
//        DepositForBurn from the known source TokenMessengerV2 naming this
//        exact amount, depositor, mint recipient, Arc domain, and Arc
//        TokenMessenger — AND a MessageSent from the known source
//        MessageTransmitterV2 whose message binds the same recipient/amount
//        and yields the message nonce (bytes32, e.g. 0xc6dd3c88…).
//        Anything else — absent events, undecodable events, or a decodable
//        event naming someone else — fails closed with BINDING_MISMATCH and
//        the intent NEVER advances to BURN_CONFIRMED. There is no
//        destinationBound=false path anymore: an unverifiable burn is an
//        unverified burn.
//   mint   (verifyArcMint):
//     1. the mint tx mined SUCCESSFULLY on Arc,
//     2. a MessageReceived from the canonical Arc MessageTransmitterV2
//        carries the SAME bytes32 nonce recorded at burn-verify time
//        (a dust transfer or an unrelated transaction has no such message
//        and is rejected with NONCE_MISMATCH),
//     3. the message body (BurnMessageV2) names this destination and the
//        full requested amount,
//     4. a MintAndWithdraw from the canonical Arc TokenMessengerV2 names
//        this destination with gross (amount + feeCollected) == the
//        requested amount — the known forwarder/relayer fee deduction
//        (production: 300000 requested, 276074 credited) is validated as
//        expected-amount-minus-fee, never as raw equality with requested,
//     5. canonical Arc USDC credited the destination for EXACTLY that net
//        amount (Transfer sum == MintAndWithdraw amount).
//
// Expected failures return { ok: false, reason } (mapped to friendly UI
// copy by callers); only programmer/config errors throw. RPC reads retry
// with backoff — source Sepolia/Amoy endpoints are flaky.

import { createPublicClient, http, decodeEventLog, pad, type Hex } from 'viem';
import { getNetworkConfig, getRpcUrls } from '@/lib/config/network';
import {
  getBridgeSourceChain,
  type BridgeSourceChain,
} from '@/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/lib/bridge/sourceViemChains';
// TokenMessenger addresses are BridgeKit's own deployment facts (same
// package the browser flow bridges through), not invented constants.
import {
  ArbitrumSepolia,
  ArcTestnet,
  BaseSepolia,
  OptimismSepolia,
  EthereumSepolia,
  PolygonAmoy,
} from '@circle-fin/bridge-kit/chains';

export const ERC20_TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

// CCTP V2 DepositForBurn — EXACT shape from Circle evm-cctp-contracts
// src/v2/TokenMessengerV2.sol. This is NOT the V1 shape the old code
// assumed: V2 removed `nonce`, added maxFee/minFinalityThreshold/hookData,
// indexes burnToken AND depositor AND minFinalityThreshold, and carries the
// remote TokenMessenger/caller as bytes32. Decoding a live Arc Testnet
// TokenMessengerV2 log with this ABI succeeds (topic0 0x0c8c1cbd…); the old
// V1 ABI never decoded a real V2 burn, so every legitimate burn silently
// fell through to destinationBound=false.
export const DEPOSIT_FOR_BURN_V2_ABI = [
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'burnToken', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
      { name: 'maxFee', type: 'uint256', indexed: false },
      { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
      { name: 'hookData', type: 'bytes', indexed: false },
    ],
  },
] as const;

// Topics: [sig, burnToken, depositor, minFinalityThreshold] (4 total) —
// this exact layout decoded a live Arc Testnet TokenMessengerV2 log
// (topic0 0x0c8c1cbd…). Do not change the indexing without re-decoding a
// live log first: the old V1-shaped ABI never decoded a real V2 burn.

// MessageTransmitterV2.MessageSent — stable across V1/V2 (single bytes).
export const MESSAGE_SENT_ABI = [
  {
    type: 'event',
    name: 'MessageSent',
    inputs: [{ name: 'message', type: 'bytes', indexed: false }],
  },
] as const;

// MessageTransmitterV2.MessageReceived — EXACT shape from Circle
// evm-cctp-contracts src/v2/MessageTransmitterV2.sol. The nonce is bytes32
// (the 0xc6dd3c88…-style message nonce seen in production), NOT the V1
// uint64. Topics: [sig, caller, nonce, finalityThresholdExecuted].
export const MESSAGE_RECEIVED_V2_ABI = [
  {
    type: 'event',
    name: 'MessageReceived',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'sourceDomain', type: 'uint32', indexed: false },
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'bytes32', indexed: false },
      { name: 'finalityThresholdExecuted', type: 'uint32', indexed: true },
      { name: 'messageBody', type: 'bytes', indexed: false },
    ],
  },
] as const;

// TokenMessengerV2.MintAndWithdraw — EXACT shape from Circle
// evm-cctp-contracts src/v2/BaseTokenMessenger.sol. `amount` is the NET
// credited to mintRecipient (the contract mints amount-fee to the
// recipient and feeCollected to the fee recipient); gross == amount +
// feeCollected == the burn amount.
export const MINT_AND_WITHDRAW_V2_ABI = [
  {
    type: 'event',
    name: 'MintAndWithdraw',
    inputs: [
      { name: 'mintRecipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'mintToken', type: 'address', indexed: true },
      { name: 'feeCollected', type: 'uint256', indexed: false },
    ],
  },
] as const;

export interface SourceCctpV2 {
  tokenMessenger: string;
  messageTransmitter: string;
  /** Circle CCTP domain id (e.g. Base Sepolia = 6, Arc Testnet = 26). */
  domain: number;
}

export function sourceCctpV2(sourceId: string): SourceCctpV2 | null {
  const defs: Record<string, any> = {
    Arbitrum_Sepolia: ArbitrumSepolia,
    Base_Sepolia: BaseSepolia,
    Optimism_Sepolia: OptimismSepolia,
    Ethereum_Sepolia: EthereumSepolia,
    Polygon_Amoy_Testnet: PolygonAmoy,
  };
  const def = defs[sourceId];
  const tm = def?.cctp?.contracts?.v2?.tokenMessenger;
  const mt = def?.cctp?.contracts?.v2?.messageTransmitter;
  const domain = def?.cctp?.domain;
  if (typeof tm !== 'string' || !tm || typeof mt !== 'string' || !mt || typeof domain !== 'number') {
    return null;
  }
  return { tokenMessenger: tm, messageTransmitter: mt, domain };
}

function arcCctpV2(): SourceCctpV2 {
  // Split authority on purpose: the Arc MessageTransmitter/domain are Arc
  // network topology (single authority: getNetworkConfig), while the Arc
  // TokenMessenger is BridgeKit's own deployment fact (same package the
  // browser flow bridges through — same precedent as sourceCctpV2 above).
  const net = getNetworkConfig();
  const tm = (ArcTestnet as any)?.cctp?.contracts?.v2?.tokenMessenger;
  if (typeof tm !== 'string' || !tm) throw new Error('Arc TokenMessengerV2 unavailable in installed bridge-kit.');
  return { tokenMessenger: tm, messageTransmitter: net.cctpMessageTransmitter, domain: net.cctpDomain };
}

// ─── Pure CCTP V2 message parsing (no RPC, no DB) ───────────────────────────
// Layouts from Circle evm-cctp-contracts (MessageV2._formatMessageForRelay
// documents the outer indices; BurnMessageV2 documents the body indices):
//   outer: version(4) sourceDomain(4) destinationDomain(4) nonce bytes32 @12
//     sender(32) recipient(32) destinationCaller(32) minFinalityThreshold(4)
//     finalityThresholdExecuted(4) messageBody @148
//   body:  version(4) burnToken(32) mintRecipient(32) @36 amount(32) @68
//     messageSender(32) maxFee(32) @132 feeExecuted(32) @164
//     expirationBlock(32) hookData @228

export interface ParsedV2Message {
  sourceDomain: number;
  destinationDomain: number;
  /** bytes32 message nonce, lowercase 0x hex (the burn↔mint binding key). */
  nonce: Hex;
  /** bytes32 sender, lowercase 0x hex (the source TokenMessenger). */
  sender: Hex;
  messageBody: Hex;
}

export interface ParsedBurnMessageV2 {
  /** bytes32 mint recipient, lowercase 0x hex. */
  mintRecipient: Hex;
  amount: bigint;
  feeExecuted: bigint;
}

function sliceBytes(hex: string, start: number, end: number): Hex | null {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length < end * 2) return null;
  return ('0x' + body.slice(start * 2, end * 2).toLowerCase()) as Hex;
}

function u32At(hex: Hex, offset: number): number | null {
  const s = sliceBytes(hex, offset, offset + 4);
  if (!s) return null;
  const n = Number(BigInt(s));
  return Number.isSafeInteger(n) ? n : null;
}

function u256At(hex: Hex, offset: number): bigint | null {
  const s = sliceBytes(hex, offset, offset + 32);
  if (!s) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

export function parseV2Message(message: string): ParsedV2Message | null {
  if (typeof message !== 'string' || !/^0x[0-9a-fA-F]+$/.test(message)) return null;
  const hex = message as Hex;
  const sourceDomain = u32At(hex, 4);
  const destinationDomain = u32At(hex, 8);
  const nonce = sliceBytes(hex, 12, 44);
  const sender = sliceBytes(hex, 44, 76);
  const body = sliceBytes(hex, 148, message.length / 2 - 1);
  if (sourceDomain === null || destinationDomain === null || !nonce || !sender || !body) return null;
  return { sourceDomain, destinationDomain, nonce, sender, messageBody: body };
}

export function parseBurnMessageV2(body: string): ParsedBurnMessageV2 | null {
  if (typeof body !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body)) return null;
  const hex = body as Hex;
  // Fixed fields end at byte 228; shorter bodies are malformed.
  if ((hex.length - 2) / 2 < 228) return null;
  const mintRecipient = sliceBytes(hex, 36, 68);
  const amount = u256At(hex, 68);
  const feeExecuted = u256At(hex, 164);
  if (!mintRecipient || amount === null || feeExecuted === null) return null;
  return { mintRecipient, amount, feeExecuted };
}

/** Last-20-bytes of a bytes32 field, as a lowercase EVM address. */
function bytes32ToAddress(b32: Hex): string {
  return ('0x' + b32.slice(-40)).toLowerCase();
}

export type ReceiptLog = { address: string; data: Hex; topics: Hex[] };

export interface BurnBindingContext {
  usdcAddress: string;
  /** Source-chain TokenMessengerV2 (event must come from here). */
  tokenMessenger: string;
  /** Source-chain MessageTransmitterV2 (MessageSent must come from here). */
  messageTransmitter: string;
  sourceAddress: string;
  amountBaseUnits: bigint;
  destination: string;
  arcDomain: number;
  arcTokenMessenger: string;
}

// ─── Pure burn-binding analysis ─────────────────────────────────────────────
// Proves, from a source receipt's logs only, that the burn is a CCTP V2
// deposit for THIS intent and extracts the bytes32 message nonce to bind
// the later mint against. Fail-closed: absent/undecodable/mismatched
// events are BINDING_MISMATCH, never a soft "unbound" success.
export function extractBurnBinding(
  logs: ReceiptLog[],
  ctx: BurnBindingContext,
): { ok: true; cctpNonce: Hex } | { ok: false; reason: 'BINDING_MISMATCH'; detail: string } {
  const tm = ctx.tokenMessenger.toLowerCase();
  const expectedRecipient = pad(ctx.destination as Hex, { size: 32 }).toLowerCase();
  const expectedArcTM = pad(ctx.arcTokenMessenger as Hex, { size: 32 }).toLowerCase();
  const expectedSender = pad(ctx.tokenMessenger as Hex, { size: 32 }).toLowerCase();

  let sawDecodableBurn = false;
  for (const log of logs ?? []) {
    if ((log.address as string).toLowerCase() !== tm) continue;
    let decoded: any;
    try {
      decoded = decodeEventLog({
        abi: DEPOSIT_FOR_BURN_V2_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'DepositForBurn') continue;
    sawDecodableBurn = true;
    const args = decoded.args as unknown as {
      burnToken: string;
      amount: bigint;
      depositor: string;
      mintRecipient: string;
      destinationDomain: number;
      destinationTokenMessenger: string;
    };
    // A decodable DepositForBurn that names a different amount/
    // depositor/recipient/token/domain/messenger is proof AGAINST this
    // intent — fail immediately, never keep scanning for a softer match.
    if (
      (args.burnToken as string).toLowerCase() !== ctx.usdcAddress.toLowerCase() ||
      BigInt(args.amount) !== ctx.amountBaseUnits ||
      (args.depositor as string).toLowerCase() !== ctx.sourceAddress.toLowerCase() ||
      (args.mintRecipient as string).toLowerCase() !== expectedRecipient ||
      Number(args.destinationDomain) !== ctx.arcDomain ||
      (args.destinationTokenMessenger as string).toLowerCase() !== expectedArcTM
    ) {
      return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Burn receipt names a different recipient, amount, token, or destination domain.' };
    }
    break;
  }
  if (!sawDecodableBurn) {
    return { ok: false, reason: 'BINDING_MISMATCH', detail: 'No verifiable CCTP burn event for this bridge in the source transaction.' };
  }

  const mt = ctx.messageTransmitter.toLowerCase();
  for (const log of logs ?? []) {
    if ((log.address as string).toLowerCase() !== mt) continue;
    let decoded: any;
    try {
      decoded = decodeEventLog({
        abi: MESSAGE_SENT_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'MessageSent') continue;
    const msg = parseV2Message((decoded.args as unknown as { message: string }).message);
    if (!msg) continue;
    // A decodable message for another domain/sender is proof against.
    if (msg.destinationDomain !== ctx.arcDomain || msg.sender !== expectedSender) {
      return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Burn message targets a different domain or sender.' };
    }
    const body = parseBurnMessageV2(msg.messageBody);
    if (!body || body.mintRecipient !== expectedRecipient || body.amount !== ctx.amountBaseUnits) {
      return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Burn message body names a different recipient or amount.' };
    }
    return { ok: true, cctpNonce: msg.nonce };
  }
  return { ok: false, reason: 'BINDING_MISMATCH', detail: 'No verifiable CCTP message for this bridge in the source transaction.' };
}

export interface MintReceiptContext {
  usdcAddress: string;
  /** Arc MessageTransmitterV2 (MessageReceived must come from here). */
  messageTransmitter: string;
  /** Arc TokenMessengerV2 (MintAndWithdraw must come from here). */
  tokenMessenger: string;
  destination: string;
  /** bytes32 message nonce recorded at burn-verify time (null = legacy row). */
  expectedNonce: string | null;
  /** Full requested amount, 6-dec base units (gross, before relayer fee). */
  expectedAmount: bigint;
  expectedSourceDomain?: number | null;
  /** bytes32 sender (source TokenMessenger), lowercase 0x hex. */
  expectedSender?: string | null;
}

export type MintBindingFailure = 'NONCE_MISMATCH' | 'AMOUNT_MISMATCH';

// ─── Pure mint-binding analysis ─────────────────────────────────────────────
// Proves, from an Arc receipt's logs only, that the transaction is THE mint
// for the burn identified by expectedNonce: same message nonce, same
// destination, gross == requested, net credit == gross − fee. A dust
// transfer or an unrelated transaction has no MessageReceived carrying the
// burn's nonce and is rejected — amount > 0 alone never completes.
export function analyzeMintReceipt(
  logs: ReceiptLog[],
  ctx: MintReceiptContext,
): { ok: true; actualAmount: bigint } | { ok: false; reason: MintBindingFailure; detail: string; actualAmount?: bigint; actualNonce?: string } {
  const dest = ctx.destination.toLowerCase();
  const nonceOk = typeof ctx.expectedNonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(ctx.expectedNonce);
  if (!nonceOk) {
    return { ok: false, reason: 'NONCE_MISMATCH', detail: 'This bridge has no recorded burn message — re-verify the source burn before completing.' };
  }
  const expected = (ctx.expectedNonce as string).toLowerCase();

  const mt = ctx.messageTransmitter.toLowerCase();
  const seenNonces: string[] = [];
  let matchedBody: ParsedBurnMessageV2 | null = null;
  for (const log of logs ?? []) {
    if ((log.address as string).toLowerCase() !== mt) continue;
    let decoded: any;
    try {
      decoded = decodeEventLog({
        abi: MESSAGE_RECEIVED_V2_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'MessageReceived') continue;
    const args = decoded.args as unknown as {
      sourceDomain: number;
      nonce: string;
      sender: string;
      messageBody: string;
    };
    const nonce = (args.nonce as string).toLowerCase();
    if (nonce !== expected) {
      if (!seenNonces.includes(nonce)) seenNonces.push(nonce);
      continue;
    }
    if (ctx.expectedSourceDomain != null && Number(args.sourceDomain) !== ctx.expectedSourceDomain) continue;
    if (ctx.expectedSender != null && (args.sender as string).toLowerCase() !== ctx.expectedSender.toLowerCase()) continue;
    const body = parseBurnMessageV2(args.messageBody);
    // The message for THIS nonce must name THIS destination and the full
    // requested amount — otherwise the mint is not this intent's.
    if (!body || bytes32ToAddress(body.mintRecipient) !== dest || body.amount !== ctx.expectedAmount) continue;
    matchedBody = body;
    break;
  }
  if (!matchedBody) {
    const seen = seenNonces.length ? ` (saw ${seenNonces.slice(0, 2).join(', ')})` : ' (no bridge message received in this transaction)';
    return { ok: false, reason: 'NONCE_MISMATCH', detail: `That transaction is not the mint for this bridge — its bridge message does not match${seen}.`, actualNonce: seenNonces[0] };
  }

  // MintAndWithdraw pins the fee accounting: gross (amount + feeCollected)
  // must equal the requested amount, and the net credited to the
  // destination must equal amount exactly.
  const tm = ctx.tokenMessenger.toLowerCase();
  let net: bigint | null = null;
  let feeCollected: bigint | null = null;
  for (const log of logs ?? []) {
    if ((log.address as string).toLowerCase() !== tm) continue;
    let decoded: any;
    try {
      decoded = decodeEventLog({
        abi: MINT_AND_WITHDRAW_V2_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'MintAndWithdraw') continue;
    const args = decoded.args as unknown as { mintRecipient: string; amount: bigint; mintToken: string; feeCollected: bigint };
    if ((args.mintRecipient as string).toLowerCase() !== dest) continue;
    if ((args.mintToken as string).toLowerCase() !== ctx.usdcAddress.toLowerCase()) continue;
    if (BigInt(args.amount) + BigInt(args.feeCollected) !== ctx.expectedAmount) continue;
    net = BigInt(args.amount);
    feeCollected = BigInt(args.feeCollected);
    break;
  }
  if (net === null || feeCollected === null) {
    return { ok: false, reason: 'AMOUNT_MISMATCH', detail: 'That transaction has no mint crediting your wallet for the bridged amount.' };
  }
  // The executed fee inside the message must agree with the collected fee:
  // both are on-chain facts about the same mint.
  if (matchedBody.feeExecuted !== feeCollected) {
    return { ok: false, reason: 'AMOUNT_MISMATCH', detail: 'That transaction credits a different amount than this bridge expects after relayer fees.' };
  }

  let credited = 0n;
  const usdc = ctx.usdcAddress.toLowerCase();
  for (const log of logs ?? []) {
    if ((log.address as string).toLowerCase() !== usdc) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { to, value } = decoded.args as unknown as { to: string; value: bigint };
      if (to.toLowerCase() === dest) credited += BigInt(value);
    } catch {
      // ignore non-Transfer logs
    }
  }
  if (credited !== net) {
    return {
      ok: false,
      reason: 'AMOUNT_MISMATCH',
      detail: `That transaction credited ${credited} base units but this bridge expects ${net} (requested ${ctx.expectedAmount} minus ${feeCollected} relayer fee).`,
      actualAmount: credited,
    };
  }
  return { ok: true, actualAmount: credited };
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  console.error(`[external-bridge-verify] ${label} failed after ${attempts} attempts:`, last);
  throw last;
}

function sourceClient(source: BridgeSourceChain) {
  const chain = sourceViemChainFor(source.chainId);
  if (!chain) throw new Error(`No viem chain for source ${source.id}`);
  return createPublicClient({ chain, transport: http() });
}

export type BurnVerifyFailure =
  | 'NOT_FOUND'
  | 'NOT_MINED'
  | 'REVERTED'
  | 'WRONG_SENDER'
  | 'AMOUNT_MISMATCH'
  | 'BINDING_MISMATCH'
  | 'RPC_UNAVAILABLE';

export interface BurnVerifyOk {
  ok: true;
  /** Always true on success: the burn provably names this destination+domain. */
  destinationBound: true;
  /** bytes32 CCTP message nonce binding this burn to its future mint. */
  cctpNonce: Hex;
  burnTxHash: Hex;
}

export async function verifyExternalBurn(params: {
  sourceId: string;
  sourceAddress: string;
  amountBaseUnits: bigint;
  destination: string;
  burnTxHash: string;
}): Promise<BurnVerifyOk | { ok: false; reason: BurnVerifyFailure; detail?: string }> {
  const { sourceId, sourceAddress, amountBaseUnits, destination, burnTxHash } = params;
  const source = getBridgeSourceChain(sourceId);
  if (!source) return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Unknown source chain.' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
    return { ok: false, reason: 'NOT_FOUND', detail: 'Not a transaction hash.' };
  }
  const hash = burnTxHash as Hex;
  const expectedFrom = sourceAddress.toLowerCase();
  const usdc = source.usdcAddress.toLowerCase();

  let receipt: any;
  try {
    const client = sourceClient(source);
    receipt = await withRpcRetry('source receipt', () =>
      client.getTransactionReceipt({ hash })
    );
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE', detail: 'Source chain RPC did not respond.' };
  }
  if (!receipt) return { ok: false, reason: 'NOT_MINED', detail: 'Transaction not found on the source chain.' };
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'REVERTED', detail: 'Source transaction reverted on-chain.' };
  }

  // Prove the sender: fetch the transaction and compare `from`.
  try {
    const client = sourceClient(source);
    const tx = await withRpcRetry('source transaction', () => client.getTransaction({ hash }));
    if (!tx || (tx.from as string).toLowerCase() !== expectedFrom) {
      return { ok: false, reason: 'WRONG_SENDER', detail: 'Transaction was not sent by the connected wallet.' };
    }
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE', detail: 'Source chain RPC did not respond.' };
  }

  // Canonical-USDC debit proof: sum Transfer(from == source) on the source
  // USDC contract inside THIS receipt. Must equal the intent amount exactly.
  let debited = 0n;
  for (const log of receipt.logs ?? []) {
    if ((log.address as string).toLowerCase() !== usdc) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { from, value } = decoded.args as unknown as { from: string; value: bigint };
      if (from.toLowerCase() === expectedFrom) debited += BigInt(value);
    } catch {
      // Non-Transfer logs on the USDC contract — ignore.
    }
  }
  if (debited !== amountBaseUnits) {
    return {
      ok: false,
      reason: 'AMOUNT_MISMATCH',
      detail: `Source USDC debit (${debited}) does not equal the bridge amount (${amountBaseUnits}).`,
    };
  }

  // Strict V2 binding (fail-closed): DepositForBurn from the known source
  // TokenMessengerV2 + MessageSent from the known source
  // MessageTransmitterV2, both naming this intent. Yields the bytes32
  // message nonce the mint must later reproduce. No soft "unbound"
  // success exists — an unverifiable burn is an unverified burn.
  const cctp = sourceCctpV2(sourceId);
  if (!cctp) {
    return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Unknown source chain.' };
  }
  const arc = arcCctpV2();
  const binding = extractBurnBinding(receipt.logs ?? [], {
    usdcAddress: source.usdcAddress,
    tokenMessenger: cctp.tokenMessenger,
    messageTransmitter: cctp.messageTransmitter,
    sourceAddress,
    amountBaseUnits,
    destination,
    arcDomain: arc.domain,
    arcTokenMessenger: arc.tokenMessenger,
  });
  if (!binding.ok) {
    return { ok: false, reason: binding.reason, detail: binding.detail };
  }

  return { ok: true, destinationBound: true, cctpNonce: binding.cctpNonce, burnTxHash: hash };
}

export type MintVerifyFailure =
  | 'NOT_FOUND'
  | 'REVERTED'
  | 'NONCE_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'RPC_UNAVAILABLE';

export interface MintVerifyOk {
  ok: true;
  actualAmount: bigint;
  mintTxHash: Hex;
}

export async function verifyArcMint(params: {
  destination: string;
  mintTxHash: string;
  /** bytes32 message nonce recorded at burn-verify time (null = legacy row). */
  expectedNonce: string | null;
  /** Full requested amount, 6-dec base units (gross, before relayer fee). */
  expectedAmount: bigint;
  expectedSourceDomain?: number | null;
  /** bytes32 sender (source TokenMessenger), lowercase 0x hex. */
  expectedSender?: string | null;
}): Promise<MintVerifyOk | { ok: false; reason: MintVerifyFailure; detail?: string; actualAmount?: bigint; actualNonce?: string }> {
  const { destination, mintTxHash } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(mintTxHash)) {
    return { ok: false, reason: 'NOT_FOUND', detail: 'Not a transaction hash.' };
  }
  const hash = mintTxHash as Hex;
  const cfg = getNetworkConfig();
  const urls = getRpcUrls();
  const arcChain = {
    id: cfg.chainId,
    name: cfg.name === 'mainnet' ? 'Arc' : 'Arc Testnet',
    nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
    rpcUrls: { default: { http: urls } },
  } as const;

  let receipt: any = null;
  let lastErr: unknown = null;
  for (const url of urls.slice(0, 3)) {
    try {
      const client = createPublicClient({ chain: arcChain, transport: http(url, { timeout: 15_000 }) });
      receipt = await client.getTransactionReceipt({ hash });
      if (receipt) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!receipt) {
    console.error('[external-bridge-verify] arc receipt unavailable:', lastErr);
    return { ok: false, reason: 'RPC_UNAVAILABLE', detail: 'Arc RPC did not respond.' };
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'REVERTED', detail: 'Destination transaction reverted on-chain.' };
  }

  // Nonce + net-amount binding (fail-closed): the receipt must carry the
  // SAME bytes32 message nonce recorded at burn time, a message body and
  // MintAndWithdraw naming this destination and the requested gross, and a
  // Transfer credit of exactly gross − fee.
  const arc = arcCctpV2();
  const analysis = analyzeMintReceipt(receipt.logs ?? [], {
    usdcAddress: cfg.usdcAddress,
    messageTransmitter: arc.messageTransmitter,
    tokenMessenger: arc.tokenMessenger,
    destination,
    expectedNonce: params.expectedNonce,
    expectedAmount: params.expectedAmount,
    expectedSourceDomain: params.expectedSourceDomain ?? null,
    expectedSender: params.expectedSender ?? null,
  });
  if (!analysis.ok) {
    return { ok: false, reason: analysis.reason, detail: analysis.detail, actualAmount: analysis.actualAmount, actualNonce: analysis.actualNonce };
  }
  return { ok: true, actualAmount: analysis.actualAmount, mintTxHash: hash };
}
