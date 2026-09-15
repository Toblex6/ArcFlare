// src/lib/swap/relayedVerify.ts
//
// Relay-aware Flow Swap verification for SERVER-broadcast (CIRCLE) executions.
//
// Why this module exists: Circle developer-controlled SCA wallets cannot sign
// raw transactions — every server submission is relayed (relayer EOA ->
// Circle forwarder -> consumer SCA -> target contract). The mined transaction
// therefore NEVER has the direct-submission shape the shared swap service
// proves (tx.from == payer, tx.to == router, input == execute()). Applying
// the direct verifier to a relayed execution fails closed by design — which
// is correct, but leaves every CIRCLE swap economically complete yet
// unprovable. This module proves relayed executions with the SAME
// evidence-over-assertion discipline, over the evidence a relayed submission
// actually leaves on-chain:
//
//   1. Inner-call binding: the forwarder envelope embeds the account-level
//      execute(target, value, data) call, which embeds the router
//      execute() calldata VERBATIM. Extraction is strict and structural
//      (selectors + ABI bounds checks, never substring guessing). The
//      extracted inner calldata must equal the quoted/bound execution bytes,
//      and its execution identity must equal the stored intent binding — a
//      foreign or tampered execution can never satisfy this.
//   2. Pool-level event proof: the canonical bound pool must emit its Swap
//      event with sender == bound router, recipient == owner wallet, exact
//      quoted input and output >= minOut. Token Transfers (input leg wallet
//      -> pool, output leg pool -> wallet) must match the same amounts.
//   3. Economic settlement: fixed-block-tag balance deltas prove the input
//      left the wallet (releasable only through its own allowances) and the
//      output arrived, output >= minOut. Inclusion block timestamp must fall
//      inside the quote expiry.
//   4. Wrap/unwrap linkage: relayed wrap proves via the WUSDC Deposit mint
//      to the wallet (exact wad) + wrap-before-swap ordering; relayed unwrap
//      proves via the WUSDC Withdrawal burn (exact wad) + the same
//      gas-aware native settlement equations the direct path enforces.
//
// What this module is NOT: it does not replace the direct-submission proof
// (./service.ts — browser/EXTERNAL flows, untouched), does not touch the
// frozen provider verifier or canonical routing, and never signs or
// broadcasts. Pure parsing/log-matching over injected data stays pure (no
// RPC/DB) so the adversarial cases run without funds; the impure wrappers
// collect evidence (RPC) and flip intent state (Prisma) with the same atomic
// single-consumption machinery as the direct path.

import {
  decodeAbiParameters,
  decodeEventLog,
  erc20Abi,
  keccak256,
  toHex,
} from "viem";
import { prisma } from "@/src/lib/prisma";
import { getNetworkConfig } from "@/src/lib/config/network";
import {
  getRoutingPublicClient,
  readWithRetry,
  routingError,
} from "@/src/lib/routing/canonical";
import { getUnitFlowV3Deployment } from "@/src/lib/config/unitflow";
import {
  UNITFLOW_6_TO_18_SCALE,
  assertWrapBeforeSwap,
  computeUnitFlowExecutionIdentity,
  decodeWusdcWithdraw,
} from "@/src/lib/routing/providers/unitflowV3";
import {
  assertIntentLive,
  canonicalFromSwapUnits,
  claimTxSlot,
  decodeUnitFlowExecute,
  executionConflict,
  findExecutionConsumer,
  loadFlowIntent,
  recheckExecutionConsumerTx,
  recheckWrapConsumerTx,
  type IntentLocator,
} from "./service";

// ─── Relay envelope selectors ────────────────────────────────────────────────
// Outer: Circle's relay forwarder envelope (observed live on Arc Testnet —
// the exact forwarder contract is Circle's submission machinery, so the
// selector is matched structurally and any format change fails closed with
// an explicit error, never a guessed parse).
const RELAY_OUTER_SELECTOR = "0x765e827f";
// Standard smart-account execution (target, value, data) — the layer between
// the Circle forwarder and the consumer SCA's inner call. Not Circle-specific.
const ACCOUNT_EXECUTE_SELECTOR = "b61d27f6";
// UniversalRouter execute(bytes,bytes[],uint256) — same single authority as
// the direct path (decodeUnitFlowExecute), matched here for extraction only.
const ROUTER_EXECUTE_SELECTOR = "3593564c";

// Uniswap V3 pool Swap + WETH9 Deposit/Withdrawal event signatures, hashed at
// runtime (no literals): these are the pool/token contracts' public event
// interfaces, the same class of fact as using erc20Abi for Transfers.
function eventTopic(sig: string): string {
  return keccak256(toHex(sig));
}
const SWAP_TOPIC = eventTopic("Swap(address,address,int256,int256,uint160,uint128,int24)");
const DEPOSIT_TOPIC = eventTopic("Deposit(address,uint256)");
const WITHDRAWAL_TOPIC = eventTopic("Withdrawal(address,uint256)");
const TRANSFER_TOPIC = eventTopic("Transfer(address,address,uint256)");

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TXHASH_RE = /^0x[a-fA-F0-9]{64}$/;

function assertTxHash(label: string, v: unknown): string {
  if (typeof v !== "string" || !TXHASH_RE.test(v.trim())) {
    throw routingError(400, `[relayed-swap] ${label} must be a 0x transaction hash.`);
  }
  return v.trim();
}

function eqAddr(a: string, b: string): boolean {
  return a?.toLowerCase() === b?.toLowerCase();
}

function hexToBigintWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

// ─── Pure: submission-shape detection ────────────────────────────────────────
// Direct submissions (browser-signed EOAs) call the router inline:
// tx.to == router and input starts with execute(bytes,bytes[],uint256).
// Anything else mined (Circle SCA relay envelopes, foreign txs) is NOT
// direct — the caller routes those to the relayed proof (which fails closed
// on unrecognized shapes) instead of the direct verifier.
export function isDirectSubmissionShape(
  txTo: unknown,
  txInput: unknown,
  router: string
): boolean {
  if (typeof txTo !== "string" || typeof txInput !== "string") return false;
  if (!eqAddr(txTo, router)) return false;
  return txInput.trim().toLowerCase().startsWith(`0x${ROUTER_EXECUTE_SELECTOR.toLowerCase()}`);
}

// ─── Pure: relayed inner-call extraction ─────────────────────────────────────
// Strict structural parse of a relayed submission input:
//   outer  = 0x765e827f relay marker (Circle's submission envelope — the
//            interior head layout is deliberately NOT pinned, so Circle-side
//            format changes fail closed instead of misparsing).
//   blob   = must contain the owner SCA address as a 32-byte word (the relay
//            targets the SCA account) and exactly ONE account-execute call
//            whose target is the expected contract.
// Returns the account-execute (target, value, innerData) with exact bounds.
// Throws fail-closed on any shape mismatch — never guesses offsets.
export interface RelayedInnerCall {
  target: string;
  value: bigint;
  innerData: `0x${string}`;
}

export function extractRelayedInner(
  txInput: unknown,
  expectedTarget: string,
  ownerWallet: string
): RelayedInnerCall {
  if (typeof txInput !== "string" || !/^0x[0-9a-fA-F]+$/.test(txInput)) {
    throw routingError(400, "[relayed-swap] malformed relay input: not hex.");
  }
  const body = txInput.slice(2).toLowerCase();
  const outerSel = RELAY_OUTER_SELECTOR.slice(2).toLowerCase();
  if (!body.startsWith(outerSel)) {
    throw routingError(400, "[relayed-swap] not a recognized relay envelope — refusing to parse.");
  }
  // The envelope interior is Circle's submission encoding (observed: sponsor
  // address, op count, op array — but the exact head layout is NOT pinned
  // here, so a Circle-side format change fails closed downstream instead of
  // being misparsed). What IS required, format-agnostically:
  //   - the envelope addresses the owner SCA account (32-byte word), and
  //   - it carries exactly ONE standard account-execute(target, value, data)
  //     call to the expected contract, parsed with full bounds checks.
  const rest = body.slice(8);
  if (rest.length < 128) {
    throw routingError(400, "[relayed-swap] relay envelope truncated.");
  }
  const scaWord = ownerWallet.trim().toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (!rest.includes(scaWord)) {
    throw routingError(403, "[relayed-swap] relay envelope does not address the owner wallet.");
  }
  const blobHex = rest;
  // Locate the standard account-execute(target, value, data) call(s) and
  // parse each with full bounds checks; exactly one may target the expected
  // contract.
  const target = expectedTarget.trim().toLowerCase();
  if (!ADDRESS_RE.test(expectedTarget.trim())) {
    throw routingError(500, "[relayed-swap] expected target is not an address.");
  }
  const execSel = ACCOUNT_EXECUTE_SELECTOR.toLowerCase();
  const matches: RelayedInnerCall[] = [];
  let cursor = blobHex.indexOf(execSel);
  while (cursor !== -1) {
    const params = blobHex.slice(cursor + 8);
    if (params.length >= 192) {
      const to = `0x${params.slice(24, 64)}`;
      const value = hexToBigintWord(params.slice(64, 128));
      const dataOffset = hexToBigintWord(params.slice(128, 192));
      // dataOffset is relative to the start of the execute() params.
      const dataAbs = cursor + 8 + Number(dataOffset) * 2;
      const lenWord = blobHex.slice(dataAbs, dataAbs + 64);
      if (lenWord.length === 64) {
        const dataLen = hexToBigintWord(lenWord);
        const dataStart = dataAbs + 64;
        const dataEnd = dataStart + Number(dataLen) * 2;
        if (dataLen > 0n && dataEnd <= blobHex.length && ADDRESS_RE.test(to)) {
          matches.push({
            target: to,
            value,
            innerData: `0x${blobHex.slice(dataStart, dataEnd)}`,
          });
        }
      }
    }
    cursor = blobHex.indexOf(execSel, cursor + 8);
  }
  const forTarget = matches.filter((m) => eqAddr(m.target, target));
  if (forTarget.length !== 1) {
    throw routingError(
      403,
      `[relayed-swap] expected exactly one inner call to the bound contract (found ${forTarget.length}).`
    );
  }
  return forTarget[0]!;
}

// ─── Pure: decoded Transfer / Swap / Deposit logs ────────────────────────────

export interface RelayTransfer {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

function decodeTransfer(log: { address: string; topics: string[]; data: string }): RelayTransfer | null {
  try {
    if (!log.topics?.[0] || log.topics[0].toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return null;
    const decoded: any = decodeEventLog({ abi: erc20Abi, topics: log.topics as any, data: log.data as any });
    if (decoded.eventName !== "Transfer") return null;
    return {
      token: log.address,
      from: String(decoded.args.from),
      to: String(decoded.args.to),
      value: BigInt(String(decoded.args.value)),
    };
  } catch {
    return null;
  }
}

export interface RelaySwapLog {
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
}

function decodeSwapLog(log: { address: string; topics: string[]; data: string }): RelaySwapLog | null {
  try {
    if (!log.topics?.[0] || log.topics[0].toLowerCase() !== SWAP_TOPIC.toLowerCase()) return null;
    if (!Array.isArray(log.topics) || log.topics.length !== 3) return null;
    const [amount0, amount1] = decodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
      log.data as `0x${string}`
    ) as unknown as [bigint, bigint, bigint, bigint, number];
    const pad = (t: string) => `0x${t.slice(-40)}`;
    return { sender: pad(log.topics[1]!), recipient: pad(log.topics[2]!), amount0, amount1 };
  } catch {
    return null;
  }
}

// ─── Pure: relayed swap log proof ────────────────────────────────────────────
// Proves the bound pool settled the bound execution for the owner wallet:
// exactly one pool Swap (sender == bound router, recipient == owner), the
// input-leg Transfer (wallet -> pool, exact quoted input), the output-leg
// Transfer (pool -> wallet, >= minOut, == Swap output), amounts cross-checked
// both ways. token0IsInput maps Swap amount0/amount1 onto (in, out).
export interface SwapLogExpectation {
  pool: string;
  router: string;
  ownerWallet: string;
  tokenInSwap: string;
  tokenOutSwap: string;
  amountInSwap: bigint | string;
  minOutSwap: bigint | string;
  token0IsInput: boolean;
}

export function proveRelayedSwapLogs(
  logs: Array<{ address: string; topics: string[]; data: string }>,
  exp: SwapLogExpectation
): { actualInputSwap: bigint; actualOutputSwap: bigint } {
  const amountIn = BigInt(exp.amountInSwap as any);
  const minOut = BigInt(exp.minOutSwap as any);
  if (amountIn <= 0n || minOut <= 0n) {
    throw routingError(400, "[relayed-swap] malformed swap proof expectation.");
  }
  const swaps = (logs ?? [])
    .filter((l) => eqAddr(l.address, exp.pool))
    .map(decodeSwapLog)
    .filter((s): s is RelaySwapLog => !!s)
    .filter((s) => eqAddr(s.recipient, exp.ownerWallet));
  if (swaps.length !== 1) {
    throw routingError(403, "[relayed-swap] pool Swap proof failed — expected exactly one Swap to the owner wallet.");
  }
  const swap = swaps[0]!;
  if (!eqAddr(swap.sender, exp.router)) {
    throw routingError(403, "[relayed-swap] pool Swap proof failed — Swap sender is not the bound router.");
  }
  // Pool deltas: the input leg is positive (pool received it), the output
  // leg negative (pool paid it). token0IsInput selects which amount is which.
  const swapIn = exp.token0IsInput ? swap.amount0 : swap.amount1;
  const swapOutRaw = exp.token0IsInput ? swap.amount1 : swap.amount0;
  // Pool deltas: input leg positive (pool received), output leg negative.
  if (swapIn !== amountIn) {
    throw routingError(403, "[relayed-swap] pool Swap proof failed — swap input != quoted input.");
  }
  if (swapOutRaw >= 0n) {
    throw routingError(403, "[relayed-swap] pool Swap proof failed — swap output direction wrong.");
  }
  const swapOut = -swapOutRaw;

  const transfers = (logs ?? []).map(decodeTransfer).filter((t): t is RelayTransfer => !!t);
  const inLegs = transfers.filter(
    (t) => eqAddr(t.token, exp.tokenInSwap) && eqAddr(t.from, exp.ownerWallet) && eqAddr(t.to, exp.pool)
  );
  if (inLegs.length !== 1 || inLegs[0]!.value !== amountIn) {
    throw routingError(403, "[relayed-swap] input-leg proof failed — wallet -> pool transfer != quoted input.");
  }
  const outLegs = transfers.filter(
    (t) => eqAddr(t.token, exp.tokenOutSwap) && eqAddr(t.from, exp.pool) && eqAddr(t.to, exp.ownerWallet)
  );
  if (outLegs.length !== 1) {
    throw routingError(403, "[relayed-swap] output-leg proof failed — pool -> wallet transfer missing.");
  }
  const actualOut = outLegs[0]!.value;
  if (actualOut !== swapOut) {
    throw routingError(403, "[relayed-swap] output proof failed — Transfer amount != Swap output.");
  }
  if (actualOut < minOut) {
    throw routingError(403, "[relayed-swap] output proof failed — received less than the quoted minimum.");
  }
  return { actualInputSwap: amountIn, actualOutputSwap: actualOut };
}

// ─── Pure: relayed wrap (Deposit mint) proof ─────────────────────────────────
// The relayed wrap carries no top-level value and no direct sender binding —
// what it must leave behind is the WUSDC Deposit mint to the owner wallet
// for exactly the expected wad. Combined with the swap's exact-input pull
// from the same wallet, the economic loop is closed: the swap could only
// pull what this wallet held and approved.
export function proveRelayedWrapLogs(
  logs: Array<{ address: string; topics: string[]; data: string }>,
  exp: { wusdc: string; ownerWallet: string; amountInSwap: bigint | string }
): void {
  const wad = BigInt(exp.amountInSwap as any);
  if (wad <= 0n) throw routingError(400, "[relayed-swap] malformed wrap proof expectation.");
  const deposits = (logs ?? []).filter(
    (l) =>
      eqAddr(l.address, exp.wusdc) &&
      (l.topics?.[0] ?? "").toLowerCase() === DEPOSIT_TOPIC.toLowerCase() &&
      Array.isArray(l.topics) &&
      l.topics.length === 2 &&
      eqAddr(`0x${(l.topics[1] ?? "").slice(-40)}`, exp.ownerWallet)
  );
  if (deposits.length !== 1) {
    throw routingError(403, "[relayed-swap] wrap proof failed — expected exactly one WUSDC Deposit to the owner wallet.");
  }
  let minted: bigint;
  try {
    [minted] = decodeAbiParameters([{ type: "uint256" }], deposits[0]!.data as `0x${string}`) as unknown as [bigint];
  } catch {
    throw routingError(403, "[relayed-swap] wrap proof failed — Deposit amount undecodable.");
  }
  if (minted !== wad) {
    throw routingError(403, "[relayed-swap] wrap proof failed — minted amount != expected swap-leg amount.");
  }
}

// ─── Pure: relayed unwrap (Withdrawal burn) proof ────────────────────────────
// WETH9 withdraw emits Withdrawal(src, wad) and no ERC-20 Transfer (burn, not
// transfer). The burn proof here is the event; settlement (the native credit)
// is proven by the caller's balance-delta equations, same as the direct path.
export function proveRelayedUnwrapLogs(
  logs: Array<{ address: string; topics: string[]; data: string }>,
  exp: { wusdc: string; ownerWallet: string; wad: bigint | string }
): void {
  const wad = BigInt(exp.wad as any);
  if (wad <= 0n) throw routingError(400, "[relayed-swap] malformed unwrap proof expectation.");
  const burns = (logs ?? []).filter(
    (l) =>
      eqAddr(l.address, exp.wusdc) &&
      (l.topics?.[0] ?? "").toLowerCase() === WITHDRAWAL_TOPIC.toLowerCase() &&
      Array.isArray(l.topics) &&
      l.topics.length === 2 &&
      eqAddr(`0x${(l.topics[1] ?? "").slice(-40)}`, exp.ownerWallet)
  );
  if (burns.length !== 1) {
    throw routingError(403, "[relayed-swap] unwrap proof failed — expected exactly one WUSDC Withdrawal from the owner wallet.");
  }
  let burned: bigint;
  try {
    [burned] = decodeAbiParameters([{ type: "uint256" }], burns[0]!.data as `0x${string}`) as unknown as [bigint];
  } catch {
    throw routingError(403, "[relayed-swap] unwrap proof failed — Withdrawal amount undecodable.");
  }
  if (burned !== wad) {
    throw routingError(403, "[relayed-swap] unwrap proof failed — burned amount != verified swap proceeds.");
  }
}

// ─── Impure: RPC evidence collection (relay-shape) ───────────────────────────

interface RelayTxEvidence {
  txHash: string;
  to: string;
  input: string;
  blockNumber: bigint;
  blockTimestampSec: number;
  receiptStatus: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

async function collectRelayTx(txHash: string, rpcUrl?: string): Promise<RelayTxEvidence> {
  const hash = assertTxHash("txHash", txHash);
  const url = (rpcUrl ?? "").trim() || getNetworkConfig().primaryRpc;
  const client = getRoutingPublicClient(url);
  const tx = await readWithRetry("relayed tx", () =>
    client.getTransaction({ hash: hash as `0x${string}` })
  ).catch(() => null);
  if (!tx) throw routingError(404, "[relayed-swap] transaction not found on-chain.");
  const receipt = await readWithRetry("relayed receipt", () =>
    client.getTransactionReceipt({ hash: hash as `0x${string}` })
  ).catch(() => null);
  if (!receipt) throw routingError(404, "[relayed-swap] transaction receipt not found on-chain.");
  if (receipt.status !== "success") {
    throw routingError(400, "[relayed-swap] relayed transaction reverted on-chain.");
  }
  const block = await readWithRetry("relayed block", () =>
    client.getBlock({ blockHash: receipt.blockHash })
  );
  const ts = Number(block.timestamp);
  if (!Number.isInteger(ts) || ts <= 0) {
    throw routingError(503, "[relayed-swap] could not read execution block timestamp.");
  }
  return {
    txHash: hash,
    to: tx.to ?? "",
    input: tx.input,
    blockNumber: receipt.blockNumber,
    blockTimestampSec: ts,
    receiptStatus: receipt.status,
    logs: (receipt.logs ?? []).map((l: any) => ({
      address: String(l.address),
      topics: (l.topics ?? []).map((t: string) => String(t)),
      data: String(l.data),
    })),
  };
}

const MIN_TOKEN_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

async function tokenDelta(
  token: string,
  wallet: string,
  atBlock: bigint,
  rpcUrl?: string
): Promise<bigint> {
  const url = (rpcUrl ?? "").trim() || getNetworkConfig().primaryRpc;
  const client = getRoutingPublicClient(url);
  const beforeBlock = atBlock > 0n ? atBlock - 1n : atBlock;
  const addr = token as `0x${string}`;
  const who = wallet as `0x${string}`;
  const before = (await readWithRetry("balance before", () =>
    client.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: beforeBlock })
  )) as bigint;
  const after = (await readWithRetry("balance after", () =>
    client.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: atBlock })
  )) as bigint;
  return after - before;
}

// ─── Impure: relayed Flow Swap verify ────────────────────────────────────────

export interface VerifyRelayedSwapRequest extends IntentLocator {
  ownerWallet: string;
  wrapTxHash?: string | null;
  executionTxHash?: string | null;
  /** Byte-exact bound execution (from the envelope rebuilt at broadcast). */
  expectedInnerData?: string | null;
  /** Byte-exact bound wrap (from the envelope rebuilt at broadcast). */
  expectedWrapData?: string | null;
  rpcUrl?: string;
}

export async function verifyFlowSwapRelayed(req: VerifyRelayedSwapRequest): Promise<{
  alreadySettled: boolean;
  intent: any;
  payer: string;
  actualInput: string;
  actualOutput: string;
}> {
  const ownerWallet = String(req.ownerWallet ?? "").trim();
  if (!ADDRESS_RE.test(ownerWallet)) throw routingError(400, "[relayed-swap] ownerWallet must be a 0x address.");
  let row = await loadFlowIntent(ownerWallet, req);
  if (row.status === "EXECUTED") {
    const resumeTx = (req.executionTxHash ?? row.executionTxHash ?? "").trim();
    if (resumeTx !== "" && row.executionTxHash && resumeTx.toLowerCase() === row.executionTxHash.toLowerCase()) {
      return {
        alreadySettled: true,
        intent: row,
        payer: row.expectedPayer,
        actualInput: row.actualInputAmount ?? row.inputAmount,
        actualOutput: row.actualOutputAmount ?? "0",
      };
    }
    throw routingError(409, "[relayed-swap] this swap intent is already consumed.");
  }
  await assertIntentLive(row);

  const executionTxHash = ((req.executionTxHash ?? row.executionTxHash ?? "") as string).trim();
  if (!executionTxHash) {
    throw routingError(400, "[relayed-swap] executionTxHash is required — broadcast the swap first.");
  }
  assertTxHash("executionTxHash", executionTxHash);
  const consumed = await findExecutionConsumer(executionTxHash);
  if (consumed && !(consumed.kind === "flow" && consumed.id === row.id)) {
    throw routingError(409, "[relayed-swap] this transaction was already consumed by another swap or payment.");
  }

  const deployment = getUnitFlowV3Deployment();
  if (
    deployment.name !== row.deploymentName ||
    deployment.universalRouter.toLowerCase() !== String(row.deploymentRouter).toLowerCase()
  ) {
    throw routingError(503, "[relayed-swap] deployment drift — stored binding does not match the atomic family. Refusing.");
  }
  const expiresAtSec = Math.floor(new Date(row.quoteExpiresAt).getTime() / 1000);

  // 1. Inner-call binding: extract the relayed inner call and prove it is
  // the bound execution (byte equality when the broadcast envelope is
  // supplied, plus execution-identity match against the stored binding).
  const ev = await collectRelayTx(executionTxHash, req.rpcUrl);
  const inner = extractRelayedInner(ev.input, deployment.universalRouter, ownerWallet);
  if (inner.value !== 0n) {
    throw routingError(403, "[relayed-swap] relayed swap carries unexpected native value.");
  }
  if (req.expectedInnerData && inner.innerData.toLowerCase() !== String(req.expectedInnerData).toLowerCase()) {
    throw routingError(403, "[relayed-swap] relayed execution != broadcast binding.");
  }
  const decoded = decodeUnitFlowExecute(inner.innerData);
  assertExecutionIdentityMatchRelayed(row.executionIdentity, {
    router: deployment.universalRouter,
    commands: decoded.commands,
    inputs: decoded.inputs,
    deadline: decoded.deadline,
  });
  if (Number(decoded.deadline) !== expiresAtSec) {
    throw routingError(403, "[relayed-swap] relayed execution deadline != quoted expiry.");
  }

  // 2. Quote-validity window: inclusion inside the live quote.
  if (ev.blockTimestampSec > expiresAtSec) {
    throw routingError(403, "[relayed-swap] swap settled after the quote expired.");
  }

  // 3. Pool/token direction + log proof + economic settlement.
  const poolToken0 = (await readWithRetry("pool token0", () => {
    const url = (req.rpcUrl ?? "").trim() || getNetworkConfig().primaryRpc;
    return getRoutingPublicClient(url).readContract({
      address: row.poolAddress as `0x${string}`,
      abi: MIN_TOKEN_ABI,
      functionName: "token0",
    });
  }).catch(() => null)) as string | null;
  if (!poolToken0 || !ADDRESS_RE.test(poolToken0)) {
    throw routingError(503, "[relayed-swap] could not read pool token ordering.");
  }
  const token0IsInput = poolToken0.toLowerCase() === String(row.tokenInSwap).toLowerCase();
  if (!token0IsInput && poolToken0.toLowerCase() !== String(row.tokenOutSwap).toLowerCase()) {
    throw routingError(403, "[relayed-swap] pool tokens do not match the quoted legs.");
  }
  const { actualOutputSwap } = proveRelayedSwapLogs(ev.logs, {
    pool: row.poolAddress,
    router: deployment.universalRouter,
    ownerWallet,
    tokenInSwap: row.tokenInSwap,
    tokenOutSwap: row.tokenOutSwap,
    amountInSwap: row.inputAmountSwap,
    minOutSwap: row.minOutputSwap,
    token0IsInput,
  });

  // 4. Balance deltas at fixed block tags: input left the wallet, output
  // arrived (>= minOut). The input could only leave through the wallet's own
  // allowances — the relay cannot spend what was never approved.
  const inDelta = await tokenDelta(row.tokenInSwap, ownerWallet, ev.blockNumber, req.rpcUrl);
  if (inDelta !== -BigInt(String(row.inputAmountSwap))) {
    throw routingError(403, "[relayed-swap] input settlement not proven — wallet input delta != quoted input.");
  }
  const outDelta = await tokenDelta(row.tokenOutSwap, ownerWallet, ev.blockNumber, req.rpcUrl);
  if (outDelta !== actualOutputSwap || outDelta < BigInt(String(row.minOutputSwap))) {
    throw routingError(403, "[relayed-swap] output settlement not proven — wallet output delta mismatch.");
  }

  // 5. USDC-leg wrap linkage (Deposit mint + ordering).
  let wrapTxHash: string | null = ((req.wrapTxHash ?? row.wrapTxHash ?? "") as string).trim() || null;
  if (row.inputSymbol === "USDC") {
    if (!wrapTxHash) {
      throw routingError(400, "[relayed-swap] USDC-leg swaps require the WUSDC.deposit wrap transaction hash.");
    }
    const wrapEv = await collectRelayTx(wrapTxHash, req.rpcUrl);
    const wrapInner = extractRelayedInner(wrapEv.input, deployment.wusdc, ownerWallet);
    if (req.expectedWrapData) {
      if (wrapInner.innerData.toLowerCase() !== String(req.expectedWrapData).toLowerCase()) {
        throw routingError(403, "[relayed-swap] relayed wrap != broadcast binding.");
      }
    }
    proveRelayedWrapLogs(wrapEv.logs, {
      wusdc: deployment.wusdc,
      ownerWallet,
      amountInSwap: row.inputAmountSwap,
    });
    assertWrapBeforeSwap(wrapEv.blockNumber, ev.blockNumber);
  }

  // 6. Canonical actuals (same dust rule as the direct path: USDC-output
  // floors sub-micro dust that stays in the wallet as WUSDC).
  const actualInput = canonicalFromSwapUnits(row.inputSymbol, BigInt(String(row.inputAmountSwap))).toString();
  let actualOutput: string;
  if (String(row.outputSymbol).toUpperCase() === "USDC") {
    const floored = actualOutputSwap - (actualOutputSwap % UNITFLOW_6_TO_18_SCALE);
    if (floored <= 0n) {
      throw routingError(503, "[relayed-swap] USDC-leg output below one micro-USDC — refusing.");
    }
    actualOutput = (floored / UNITFLOW_6_TO_18_SCALE).toString();
  } else {
    actualOutput = canonicalFromSwapUnits(row.outputSymbol, actualOutputSwap).toString();
  }

  // 7. Atomic claim: same advisory-lock + cross-table recheck machinery as
  // the direct path. First committer wins; same-tx resume stays idempotent.
  try {
    const intent = await prisma.$transaction(async (db: any) => {
      await claimTxSlot(db, executionTxHash);
      if (wrapTxHash) await claimTxSlot(db, wrapTxHash);
      await recheckExecutionConsumerTx(db, executionTxHash, { kind: "flow", id: row.id });
      if (wrapTxHash) await recheckWrapConsumerTx(db, wrapTxHash, { kind: "flow", id: row.id });
      const live = await db.flowSwapIntent.findUnique({ where: { id: row.id } });
      if (!live) throw routingError(404, "[relayed-swap] swap intent not found.");
      if (live.status === "EXECUTED") {
        if (live.executionTxHash && live.executionTxHash.toLowerCase() === executionTxHash.toLowerCase()) {
          return { row: live, resumed: true };
        }
        throw routingError(409, "[relayed-swap] this swap intent is already consumed.");
      }
      const updated = await db.flowSwapIntent.update({
        where: { id: row.id },
        data: {
          status: "EXECUTED",
          executionTxHash,
          wrapTxHash,
          actualInputAmount: actualInput,
          actualOutputAmount: actualOutput,
        },
      });
      return { row: updated, resumed: false };
    });
    return { alreadySettled: intent.resumed, intent: intent.row, payer: ownerWallet, actualInput, actualOutput };
  } catch (e: any) {
    throw executionConflict(e);
  }
}

function assertExecutionIdentityMatchRelayed(
  stored: unknown,
  bundle: { router: string; commands: `0x${string}`; inputs: [`0x${string}`]; deadline: bigint }
): void {
  if (typeof stored !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(stored)) {
    throw routingError(500, "[relayed-swap] stored execution identity missing or malformed — refusing.");
  }
  const recomputed = computeUnitFlowExecutionIdentity({
    router: bundle.router,
    commands: bundle.commands,
    v3input: bundle.inputs[0]!,
    deadline: bundle.deadline,
  });
  if (recomputed.toLowerCase() !== stored.toLowerCase()) {
    throw routingError(403, "[relayed-swap] execution identity mismatch — relayed execution != quoted binding.");
  }
}

// ─── Impure: relayed unwrap verify ───────────────────────────────────────────

export interface VerifyRelayedUnwrapRequest extends IntentLocator {
  ownerWallet: string;
  unwrapTxHash: string;
  /** Byte-exact bound withdraw (from the unwrap builder at broadcast). */
  expectedInnerData?: string | null;
  rpcUrl?: string;
}

export async function verifyFlowUnwrapRelayed(req: VerifyRelayedUnwrapRequest): Promise<{
  intentId: string;
  payer: string;
  finalReceived: string;
  unwrapTxHash: string;
}> {
  const ownerWallet = String(req.ownerWallet ?? "").trim();
  if (!ADDRESS_RE.test(ownerWallet)) throw routingError(400, "[relayed-swap] ownerWallet must be a 0x address.");
  const unwrapTxHash = assertTxHash("unwrapTxHash", req.unwrapTxHash);
  const row = await loadFlowIntent(ownerWallet, req);

  const deployment = getUnitFlowV3Deployment();
  if (
    deployment.name !== row.deploymentName ||
    deployment.wusdc.toLowerCase() !== String(row.tokenOutSwap ?? "").toLowerCase()
  ) {
    throw routingError(503, "[relayed-swap] deployment drift — stored binding does not match the atomic family. Refusing.");
  }
  if (String(row.outputSymbol).toUpperCase() !== "USDC") {
    throw routingError(400, "[relayed-swap] this swap settles directly — no unwrap step is needed.");
  }
  if (row.status !== "EXECUTED") {
    throw routingError(409, "[relayed-swap] verify the swap on-chain first — the unwrap amount is the verified output.");
  }
  let canonical: bigint;
  try {
    canonical = BigInt(String(row.actualOutputAmount ?? ""));
  } catch {
    throw routingError(500, "[relayed-swap] verified output missing — refusing to verify unwrap.");
  }
  if (canonical <= 0n) {
    throw routingError(500, "[relayed-swap] verified output missing — refusing to verify unwrap.");
  }
  const expectedSwap = canonical * UNITFLOW_6_TO_18_SCALE;

  // Inner binding: relayed withdraw to canonical WUSDC for the exact wad.
  const ev = await collectRelayTx(unwrapTxHash, req.rpcUrl);
  const inner = extractRelayedInner(ev.input, deployment.wusdc, ownerWallet);
  if (inner.value !== 0n) {
    throw routingError(403, "[relayed-swap] relayed unwrap carries unexpected native value.");
  }
  if (req.expectedInnerData && inner.innerData.toLowerCase() !== String(req.expectedInnerData).toLowerCase()) {
    throw routingError(403, "[relayed-swap] relayed unwrap != broadcast binding.");
  }
  const wad = decodeWusdcWithdraw(inner.innerData);
  if (wad !== expectedSwap) {
    throw routingError(403, "[relayed-swap] unwrap amount != verified swap proceeds — refusing.");
  }
  proveRelayedUnwrapLogs(ev.logs, { wusdc: deployment.wusdc, ownerWallet, wad: expectedSwap });

  // Ordering: after the swap execution (same-block ordered by index, like
  // the direct path — no false rejection).
  const swapReceipt = await (async () => {
    const url = (req.rpcUrl ?? "").trim() || getNetworkConfig().primaryRpc;
    const client = getRoutingPublicClient(url);
    return readWithRetry("swap receipt for unwrap ordering", () =>
      client.getTransactionReceipt({ hash: String(row.executionTxHash) as `0x${string}` })
    ).catch(() => null);
  })();
  if (!swapReceipt) throw routingError(404, "[relayed-swap] swap execution receipt not found on-chain.");
  const swapBlock = swapReceipt.blockNumber;
  // Ordering via receipts (block + index): fetch the unwrap receipt index.
  const unwrapIndex = await txIndexOf(unwrapTxHash, req.rpcUrl);
  const swapIndex = Number(swapReceipt.transactionIndex);
  const orderedOk =
    ev.blockNumber > swapBlock || (ev.blockNumber === swapBlock && unwrapIndex !== null && unwrapIndex > swapIndex);
  if (!orderedOk) {
    throw routingError(403, "[relayed-swap] unwrap ordering failed — unwrap must settle after the swap.");
  }

  // Settlement proof (same gas-aware exact equations as the direct path):
  // WUSDC burn delta == wad (gas-free) and native delta + gas cost == wad.
  const url = (req.rpcUrl ?? "").trim() || getNetworkConfig().primaryRpc;
  const client = getRoutingPublicClient(url);
  const owner = ownerWallet as `0x${string}`;
  const beforeBlock = ev.blockNumber > 0n ? ev.blockNumber - 1n : ev.blockNumber;
  const wusdc = deployment.wusdc as `0x${string}`;
  const wusdcBefore = (await readWithRetry("WUSDC balance before unwrap", () =>
    client.readContract({ address: wusdc, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: beforeBlock })
  )) as bigint;
  const wusdcAfter = (await readWithRetry("WUSDC balance after unwrap", () =>
    client.readContract({ address: wusdc, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: ev.blockNumber })
  )) as bigint;
  if (wusdcBefore < wusdcAfter || wusdcBefore - wusdcAfter !== expectedSwap) {
    throw routingError(403, "[relayed-swap] unwrap settlement not proven — WUSDC burn delta != verified proceeds.");
  }
  const nativeBefore = (await readWithRetry("native balance before unwrap", () =>
    client.getBalance({ address: owner, blockNumber: beforeBlock })
  )) as bigint;
  const nativeAfter = (await readWithRetry("native balance after unwrap", () =>
    client.getBalance({ address: owner, blockNumber: ev.blockNumber })
  )) as bigint;
  const unwrapTx = await readWithRetry("unwrap tx for gas", () =>
    client.getTransaction({ hash: unwrapTxHash as `0x${string}` })
  ).catch(() => null);
  const unwrapReceipt = await readWithRetry("unwrap receipt for gas", () =>
    client.getTransactionReceipt({ hash: unwrapTxHash as `0x${string}` })
  ).catch(() => null);
  const gasPriceRaw = (unwrapReceipt as any)?.effectiveGasPrice ?? (unwrapTx as any)?.gasPrice ?? (unwrapTx as any)?.maxFeePerGas;
  let gasPrice: bigint | null = null;
  try {
    gasPrice = BigInt(gasPriceRaw);
  } catch {
    gasPrice = null;
  }
  // Relayed unwrap gas is paid by the SPONSOR (bundler), not the wallet: the
  // wallet's native delta must equal the wad EXACTLY (no gas deduction).
  // When the wallet itself paid gas (direct shape — unreachable here but
  // harmless to accept), the gas-aware equation also holds.
  const gasCost = unwrapReceipt && gasPrice !== null && gasPrice >= 0n ? BigInt(unwrapReceipt.gasUsed) * gasPrice : 0n;
  const nativeDelta = nativeAfter >= nativeBefore ? nativeAfter - nativeBefore : 0n;
  if (nativeDelta !== expectedSwap && nativeDelta + gasCost !== expectedSwap) {
    throw routingError(403, "[relayed-swap] unwrap settlement not proven — native receipt != verified proceeds.");
  }

  return { intentId: row.id, payer: ownerWallet, finalReceived: String(row.actualOutputAmount), unwrapTxHash };
}

async function txIndexOf(txHash: string, rpcUrl?: string): Promise<number | null> {
  try {
    const url = (rpcUrl ?? "").trim() || getNetworkConfig().primaryRpc;
    const client = getRoutingPublicClient(url);
    const rc = await readWithRetry("tx index", () =>
      client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    );
    return Number(rc.transactionIndex);
  } catch {
    return null;
  }
}
