// src/lib/swap/serverExecute.ts
//
// Server-executed Flow Swap for CIRCLE consumers (Circle developer-controlled
// SCA). This is the second Flow Swap execution path:
//
//   EXTERNAL wallets: browser signs (quote → sign → execute-intent → verify).
//   CIRCLE wallets:   the server signs here (quote → execute → verify).
//
// The quote, intent persistence, verification, unwrap, and unwrap-
// verification are the EXISTING shared swap service (./service.ts) — this
// module only adds the broadcast step the browser performs for EXTERNAL
// wallets, executed from the consumer's own Circle SCA via the
// developer-controlled Circle client (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET).
//
// Rules (fail-closed, server-resolved, no silent fallback):
// - The ONLY client input is the intent locator (intentId/quoteHash). Every
//   amount, token, pool, fee, calldata byte, and recipient is re-derived
//   server-side and bound to the stored QUOTED intent before anything is
//   submitted: the unsigned execution is REBUILT live and its binding
//   (executionIdentity + pool + fee + quoted + minOut) must equal the stored
//   row exactly, or execution refuses (re-quote instead of executing stale).
// - Submitted calldata is byte-identical to the bound envelope (Circle
//   `callData` carries the envelope's own bytes — never re-encoded from
//   parts, never client-supplied).
// - One Circle submission per step, strictly sequential, each awaited to
//   on-chain finality before the next submits: approvals → wrap (USDC-leg
//   inputs only) → execute() → [USDC-output only] withdraw. Ordering is
//   therefore structural, and the existing verify steps still prove every
//   linkage, ordering, payer, and settlement equation on-chain afterwards.
// - Nothing here returns routers, pools, calldata, or provider internals —
//   the summary carries symbols, verified actuals, and tx hashes only.
// - This module is intentionally SEPARATE from ./service.ts: the shared
//   service never signs (statically proven), while this module exists
//   precisely to sign for CIRCLE wallets. EXTERNAL wallets never reach it
//   (the route rejects them before calling in).

import { formatUnits } from "viem";
import { getCircleClient } from "@/src/lib/circle/client";
import { getNetworkConfig } from "@/src/lib/config/network";
import { getRoutingPublicClient, readWithRetry, routingError } from "@/src/lib/routing/canonical";
import { getUnitFlowV3Deployment } from "@/src/lib/config/unitflow";
import { getTokenBySymbol } from "@/src/lib/tokens/supportedTokens";
import {
  assertIntentLive,
  loadFlowIntent,
  registerFlowSwapExecution,
  requestFlowUnwrap,
  verifyFlowSwap,
  type IntentLocator,
} from "./service";
import {
  isDirectSubmissionShape,
  verifyFlowSwapRelayed,
  verifyFlowUnwrapRelayed,
} from "./relayedVerify";
import { buildUnitFlowV3Execution } from "@/src/lib/routing/providers/unitflowV3";

export interface ServerSwapRequest extends IntentLocator {
  /** Authenticated session wallet — must own the intent. */
  ownerWallet: string;
  /** Circle developer-controlled wallet id the server signs with. */
  circleWalletId: string;
}

export interface ServerSwapResult {
  intentId: string;
  status: string;
  alreadySettled: boolean;
  input: { symbol: string; amount: string; amountDisplay: string };
  output: { symbol: string; actual: string };
  executionTxHash: string | null;
  wrapTxHash: string | null;
  unwrapTxHash: string | null;
  /** True when the swap is EXECUTED into USDC but the unwrap exit still needs
   *  to run (retry path, or a fresh-path crash after swap verification).
   *  Complete it via POST /api/swap/unwrap + /api/swap/verify-unwrap. */
  unwrapPending: boolean;
}

// ─── Submission-shape dispatch ───────────────────────────────────────────────
// Circle SCA submissions are relayed by construction (relayer EOA ->
// forwarder -> SCA -> target), so the direct-submission proof cannot cover
// them. Peek at the mined transaction and prove each shape with its own
// verifier: direct (shared service) or relayed (./relayedVerify). Unknown
// shapes fail closed.
async function verifyBroadcastSwap(args: {
  ownerWallet: string;
  intentId: string;
  wrapTxHash: string | null;
  executionTxHash: string;
  expectedInnerData?: string | null;
  expectedWrapData?: string | null;
}): Promise<{ alreadySettled: boolean; intent: any; payer: string; actualInput: string; actualOutput: string }> {
  const deployment = getUnitFlowV3Deployment();
  const client = getRoutingPublicClient(getNetworkConfig().primaryRpc);
  const tx = await readWithRetry("broadcast tx shape", () =>
    client.getTransaction({ hash: args.executionTxHash as `0x${string}` })
  ).catch(() => null);
  if (!tx) throw routingError(404, "[swap-execute] broadcast transaction not found on-chain.");
  if (isDirectSubmissionShape(tx.to ?? "", tx.input, deployment.universalRouter)) {
    return verifyFlowSwap({
      ownerWallet: args.ownerWallet,
      intentId: args.intentId,
      ...(args.wrapTxHash ? { wrapTxHash: args.wrapTxHash } : {}),
      executionTxHash: args.executionTxHash,
    });
  }
  return verifyFlowSwapRelayed({
    ownerWallet: args.ownerWallet,
    intentId: args.intentId,
    wrapTxHash: args.wrapTxHash ?? null,
    executionTxHash: args.executionTxHash,
    ...(args.expectedInnerData ? { expectedInnerData: args.expectedInnerData } : {}),
    ...(args.expectedWrapData ? { expectedWrapData: args.expectedWrapData } : {}),
  });
}

// Circle transaction finality poll — same discipline as the settlement
// engine (40 x 2.5s). Returns the mined tx hash or throws fail-closed.
async function waitForCircleTxHash(client: any, txId: string, label: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash as string;
    }
    if (data?.transaction?.state === "FAILED") {
      throw routingError(
        502,
        `[swap-execute] ${label} failed on-chain: ${data.transaction.errorReason || "unknown reason"}`
      );
    }
  }
  throw routingError(504, `[swap-execute] ${label} timed out waiting for on-chain finality.`);
}

// Submit ONE unsigned envelope step from the consumer's Circle SCA and wait
// for finality. `nativeAmount` carries native value for payable calls only
// (WUSDC.deposit wrap); every other step submits with zero value.
async function submitEnvelopeStep(args: {
  walletId: string;
  to: string;
  callData: string;
  nativeAmount?: string;
  label: string;
}): Promise<string> {
  const client = getCircleClient();
  let txId: string | undefined;
  try {
    const tx = await (client as any).createContractExecutionTransaction({
      walletId: args.walletId,
      contractAddress: args.to,
      callData: args.callData,
      ...(args.nativeAmount ? { amount: args.nativeAmount } : {}),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    txId = tx?.data?.id;
  } catch (e: any) {
    throw routingError(
      502,
      `[swap-execute] ${args.label} submission rejected: ${String(e?.message ?? e).slice(0, 200)}`
    );
  }
  if (!txId) {
    throw routingError(502, `[swap-execute] ${args.label} submission returned no transaction id.`);
  }
  return waitForCircleTxHash(client, txId, args.label);
}

function displayAmount(v: string, decimals: number): string {
  try {
    const s = BigInt(v).toString().padStart(decimals + 1, "0");
    return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/^0+(?=\d)/, "") || `0.${"0".repeat(decimals)}`;
  } catch {
    return v;
  }
}

/** Canonical decimals for a stored intent symbol (fail-closed default 6 never overstates). */
function tokenDecimalsFor(symbol: string): number {
  try {
    return getTokenBySymbol(symbol.trim().toUpperCase() as "USDC" | "EURC" | "CIRBTC").decimals;
  } catch {
    return 6;
  }
}

/**
 * Execute a live QUOTED Flow Swap intent from the consumer's own Circle SCA
 * and verify it on-chain end to end (swap verify, plus unwrap +
 * unwrap-verify for USDC-output swaps). Returns the verified summary.
 */
export async function executeFlowSwapAsServer(req: ServerSwapRequest): Promise<ServerSwapResult> {
  const ownerWallet = String(req.ownerWallet ?? "").trim();
  const circleWalletId = String(req.circleWalletId ?? "").trim();
  if (!ownerWallet) throw routingError(400, "[swap-execute] owner wallet is required.");
  if (!circleWalletId) throw routingError(400, "[swap-execute] no signing identity bound to this wallet.");

  // Ownership + liveness: the intent must belong to the session wallet and
  // still be live. EXECUTED intents refuse here (409) — re-verify them via
  // POST /api/swap/verify instead of rebroadcasting.
  const row = await loadFlowIntent(ownerWallet, req);

  // No-double-broadcast rule: a previous server attempt may already have
  // broadcast (hashes stored, intent still QUOTED because verification never
  // completed). Rebroadcasting would execute the swap a SECOND time — real
  // double-spend. Recovery is verify-only: prove the stored broadcast, never
  // submit new transactions. (The unwrap leg does not run on this path — a
  // USDC-output retry that flips EXECUTED reports unwrapPending and the exit
  // completes via POST /api/swap/unwrap + /api/swap/verify-unwrap.)
  if (row.executionTxHash) {
    const recovered = await verifyBroadcastSwap({
      ownerWallet,
      intentId: row.id,
      wrapTxHash: row.wrapTxHash ?? null,
      executionTxHash: String(row.executionTxHash),
    });
    const needsUnwrap =
      String(row.outputSymbol).toUpperCase() === "USDC" && recovered.intent.status === "EXECUTED";
    const inputDecimals = tokenDecimalsFor(String(row.inputSymbol));
    return {
      intentId: recovered.intent.id,
      status: recovered.intent.status,
      alreadySettled: recovered.alreadySettled,
      input: {
        symbol: String(row.inputSymbol),
        amount: String(row.inputAmount),
        amountDisplay: displayAmount(String(row.inputAmount), inputDecimals),
      },
      output: { symbol: String(row.outputSymbol), actual: recovered.actualOutput },
      executionTxHash: recovered.intent.executionTxHash ?? String(row.executionTxHash),
      wrapTxHash: recovered.intent.wrapTxHash ?? (row.wrapTxHash ? String(row.wrapTxHash) : null),
      unwrapTxHash: null,
      unwrapPending: needsUnwrap,
    };
  }

  await assertIntentLive(row);

  // Rebuild the unsigned execution live and bind it to the stored row. Any
  // drift (pool liquidity moved, fee tier changed, quote re-priced) fails
  // closed — the caller re-quotes instead of executing stale terms.
  const expiresAtSec = Math.floor(new Date(row.quoteExpiresAt).getTime() / 1000);
  const envelope = await buildUnitFlowV3Execution({
    inputSymbol: row.inputSymbol,
    outputSymbol: row.outputSymbol,
    inputAmount: BigInt(String(row.inputAmount)),
    merchantSCA: ownerWallet,
    expectedPayer: ownerWallet,
    allowSelfPayer: true,
    slippageBps: Number(row.slippageBps),
    expiresAtSec,
    feeTier: Number(row.feeTier),
  });
  if (envelope.executionIdentity.toLowerCase() !== String(row.executionIdentity).toLowerCase()) {
    throw routingError(
      409,
      "[swap-execute] live execution no longer matches the quoted binding (pool/price moved) — request a fresh quote."
    );
  }
  if (
    envelope.pool.toLowerCase() !== String(row.poolAddress).toLowerCase() ||
    envelope.fee !== Number(row.feeTier) ||
    envelope.quotedOutputSwap.toString() !== String(row.quotedOutputSwap) ||
    envelope.minOutSwap.toString() !== String(row.minOutputSwap)
  ) {
    throw routingError(
      409,
      "[swap-execute] live quote terms drifted from the stored intent — request a fresh quote."
    );
  }

  // Broadcast each envelope step from the consumer's SCA, strictly in order,
  // awaiting finality each time. Step bytes are the envelope's own calldata.
  const approvalHashes: string[] = [];
  for (let i = 0; i < envelope.approvals.length; i++) {
    const step = envelope.approvals[i]!;
    if (step.value !== 0n) {
      throw routingError(500, "[swap-execute] approval step carries unexpected native value — refusing.");
    }
    approvalHashes.push(
      await submitEnvelopeStep({
        walletId: circleWalletId,
        to: step.to,
        callData: step.data,
        label: `approval ${i + 1}/${envelope.approvals.length}`,
      })
    );
  }

  let wrapTxHash: string | null = null;
  if (envelope.wrapTx) {
    // USDC-leg wrap: WUSDC.deposit{value} — the native value travels in the
    // Circle `amount` field (decimal native units), never in calldata.
    const nativeDecimal = formatUnits(envelope.wrapTx.value, 18);
    wrapTxHash = await submitEnvelopeStep({
      walletId: circleWalletId,
      to: envelope.wrapTx.to,
      callData: envelope.wrapTx.data,
      nativeAmount: nativeDecimal,
      label: "WUSDC wrap",
    });
  } else if (row.inputSymbol === "USDC") {
    throw routingError(500, "[swap-execute] USDC-leg intent rebuilt without its wrap step — refusing.");
  }

  if (envelope.swapTx.value !== 0n) {
    throw routingError(500, "[swap-execute] swap step carries unexpected native value — refusing.");
  }
  const executionTxHash = await submitEnvelopeStep({
    walletId: circleWalletId,
    to: envelope.swapTx.to,
    callData: envelope.swapTx.data,
    label: "swap execution",
  });

  // Register the server-broadcast hashes (atomic single-consumption) and
  // prove the execution on-chain. Status becomes EXECUTED only inside the
  // verifier — a broadcast alone is never success.
  await registerFlowSwapExecution({
    ownerWallet,
    intentId: row.id,
    ...(wrapTxHash ? { wrapTxHash } : {}),
    executionTxHash,
  });
  const verified = await verifyBroadcastSwap({
    ownerWallet,
    intentId: row.id,
    wrapTxHash,
    executionTxHash,
    expectedInnerData: envelope.swapTx.data,
    ...(envelope.wrapTx ? { expectedWrapData: envelope.wrapTx.data } : {}),
  });

  // USDC-output swaps credit WUSDC first — complete the exit the same way
  // the browser flow does: server-built exact withdraw, server-broadcast
  // from the same SCA, then relayed unwrap verification (server broadcasts
  // are relayed by construction, so the direct unwrap proof cannot cover
  // them).
  let unwrapTxHash: string | null = null;
  let finalOutput = verified.actualOutput;
  if (String(row.outputSymbol).toUpperCase() === "USDC") {
    const unwrap = await requestFlowUnwrap({ ownerWallet, intentId: row.id });
    if (unwrap.unwrapTx.value !== "0") {
      throw routingError(500, "[swap-execute] unwrap step carries unexpected native value — refusing.");
    }
    unwrapTxHash = await submitEnvelopeStep({
      walletId: circleWalletId,
      to: unwrap.unwrapTx.to,
      callData: unwrap.unwrapTx.data,
      label: "USDC unwrap",
    });
    const unwrapVerified = await verifyFlowUnwrapRelayed({
      ownerWallet,
      intentId: row.id,
      unwrapTxHash,
      expectedInnerData: unwrap.unwrapTx.data,
    });
    finalOutput = unwrapVerified.finalReceived;
  }

  return {
    intentId: verified.intent.id,
    status: verified.intent.status,
    alreadySettled: verified.alreadySettled,
    input: {
      symbol: String(row.inputSymbol),
      amount: String(row.inputAmount),
      amountDisplay: displayAmount(String(row.inputAmount), tokenDecimalsFor(String(row.inputSymbol))),
    },
    output: { symbol: String(row.outputSymbol), actual: finalOutput },
    executionTxHash: verified.intent.executionTxHash ?? executionTxHash,
    wrapTxHash: verified.intent.wrapTxHash ?? wrapTxHash,
    unwrapTxHash,
    unwrapPending: false,
  };
}
