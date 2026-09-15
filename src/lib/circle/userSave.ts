// src/lib/circle/userSave.ts
//
// Server-side USER_CONTROLLED savings-reminder orchestration (consumer Save
// fallback UX): the server builds the exact USDC transfer calldata and
// creates a Circle contractExecution challenge; the BROWSER executes each
// challengeId through the Web SDK (setAuthentication -> execute) and then
// POSTs to /api/consumer/save/confirm, which polls the challenge → Circle
// tx → mined receipt (Transfer-event proof) before reporting success.
//
// Custody discipline (same as userBridge.ts / userControlled.ts): this
// module NEVER sees, stores, or transports private keys or user key
// material. The per-request `userToken` arrives in the request body, is
// passed through as X-User-Token, and is never logged or persisted.
// Challenge execution (signing) happens exclusively in the browser.
//
// Why this exists: Circle user-controlled wallets cannot be debited
// server-side, so POST /api/payments/scheduled refuses them (fail closed).
// The reminder flow does NOT promise automation — each cycle produces a
// pending "Ready to save" prompt the user opens and approves with one
// Circle challenge. Savings plans themselves live in the browser
// (localStorage per wallet); the server only mints and verifies the
// per-cycle transfer challenge. Nothing here touches the CIRCLE
// developer-controlled automatic scheduled-debit path or merchant
// payroll/scheduled code.
//
// Server-only: importing this module in a browser bundle throws (same rule
// as userControlled.ts) so CIRCLE_API_KEY can never leak client-side.

import { encodeFunctionData, getAddress, type Hex } from "viem";
import { getTokenBySymbol } from "@/lib/tokens/supportedTokens";
import {
  createUserContractExecutionChallenge,
  getUserControlledConfig,
  listUserControlledWallets,
} from "@/lib/circle/userControlled";
import { pollChallengeToTx } from "@/lib/circle/userBridge";
import { getPublicClient } from "@/lib/wallet/chainClient";

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/circle/userSave.ts is server-only (it carries CIRCLE_API_KEY) and must never be bundled for the browser."
  );
}

// Minimal ERC-20 ABI for the savings transfer (encode-only) and for receipt
// proof (Transfer event decode).
const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// Human "12.50" → 6-dec minor units. Save is USDC-only (matches the
// automatic Save form today); the token itself resolves via the canonical
// registry — never a hardcoded address.
export function parseSaveAmountMinor(raw: unknown): bigint {
  const s = String(raw ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw Object.assign(
      new Error("Amount must be a positive USDC value with at most 6 decimals."),
      { status: 400, code: "INVALID_AMOUNT" }
    );
  }
  const [whole, frac = ""] = s.split(".");
  const minor = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  if (minor <= 0n) {
    throw Object.assign(new Error("Amount must be positive."), {
      status: 400,
      code: "INVALID_AMOUNT",
    });
  }
  return minor;
}

export function encodeSaveTransferCallData(args: {
  destination: string;
  amountMinor: bigint;
}): Hex {
  if (args.amountMinor <= 0n) {
    throw Object.assign(new Error("Amount must be positive."), {
      status: 400,
      code: "INVALID_AMOUNT",
    });
  }
  return encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: "transfer",
    args: [getAddress(args.destination), args.amountMinor],
  });
}

// ── Intent store ────────────────────────────────────────────────────────────
// Process-local like userBridgeIntents (single long-running instance; a
// restart loses in-flight save intents — the browser simply starts the
// cycle over; no funds move until the user executes a challenge, so a lost
// intent is safe).
export interface UserSaveIntent {
  reference: string;
  senderAddress: `0x${string}`;
  destinationAddress: `0x${string}`;
  amountMinor: string;
  tokenAddress: string;
  walletId: string;
  circleBlockchain: string;
  pendingChallengeId: string | null;
  createdAt: number;
  updatedAt: number;
}

const userSaveIntents = new Map<string, UserSaveIntent>();

function makeReference(): string {
  return `ucsave_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

export function getUserSaveIntent(reference: string): UserSaveIntent | null {
  return userSaveIntents.get(reference) ?? null;
}

export function setUserSaveIntent(intent: UserSaveIntent): void {
  intent.updatedAt = Date.now();
  userSaveIntents.set(intent.reference, intent);
}

export function clearUserSaveIntent(reference: string): void {
  userSaveIntents.delete(reference);
}

// Trust anchor (mirrors resolveUserSourceWallet): only addresses Circle
// returns for THIS userToken may save. The session address must be among
// them; returns the Arc wallet resource (walletId for challenges).
export async function resolveUserSaveWallet(args: {
  userToken: string;
  sessionAddress: string;
}): Promise<{ walletId: string }> {
  const config = getUserControlledConfig();
  const wallets = await listUserControlledWallets(args.userToken, config);
  const session = args.sessionAddress.toLowerCase();
  const owned = wallets.filter((w) => w.address.toLowerCase() === session);
  if (owned.length === 0) {
    throw Object.assign(
      new Error("This wallet does not belong to the authenticated Circle identity."),
      { status: 403, code: "CIRCLE_WALLET_MISMATCH" }
    );
  }
  const onArc = owned.find(
    (w) => w.blockchain?.toUpperCase() === config.blockchain.toUpperCase()
  );
  if (!onArc) {
    throw Object.assign(
      new Error("Your wallet is not on the Arc network yet — finish wallet creation first."),
      { status: 409, code: "WALLET_NOT_ON_CHAIN" }
    );
  }
  return { walletId: onArc.id };
}

// Build the per-cycle savings challenge: USDC transfer(sender →
// destination, exact amount) on Arc. Destination defaults to the sender
// (self-save, same as the automatic Save form's payer == receiver); an
// explicit third-party destination is accepted only as a valid 0x address
// distinct from nothing — the receipt proof below binds it exactly.
export async function createSaveChallenge(args: {
  userToken: string;
  walletId: string;
  destination: `0x${string}`;
  amountMinor: bigint;
  refId: string;
}): Promise<{ challengeId: string; tokenAddress: string; blockchain: string }> {
  const config = getUserControlledConfig();
  const token = getTokenBySymbol("USDC");
  const callData = encodeSaveTransferCallData({
    destination: getAddress(args.destination),
    amountMinor: args.amountMinor,
  });
  const { challengeId } = await createUserContractExecutionChallenge(
    args.userToken,
    {
      contractAddress: token.address,
      callData,
      blockchain: config.blockchain,
      walletId: args.walletId,
      feeLevel: "MEDIUM",
      refId: args.refId,
    },
    config
  );
  return { challengeId, tokenAddress: token.address, blockchain: config.blockchain };
}

export function newSaveIntent(args: {
  senderAddress: `0x${string}`;
  destinationAddress: `0x${string}`;
  amountMinor: bigint;
  tokenAddress: string;
  walletId: string;
  circleBlockchain: string;
  pendingChallengeId: string;
}): UserSaveIntent {
  const intent: UserSaveIntent = {
    reference: makeReference(),
    senderAddress: args.senderAddress,
    destinationAddress: args.destinationAddress,
    amountMinor: args.amountMinor.toString(),
    tokenAddress: args.tokenAddress,
    walletId: args.walletId,
    circleBlockchain: args.circleBlockchain,
    pendingChallengeId: args.pendingChallengeId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  setUserSaveIntent(intent);
  return intent;
}

// Confirm-step: poll the executed challenge → Circle tx, then prove the
// mined receipt really was OUR savings transfer: receipt success +
// receipt.to === USDC contract + a Transfer event from the USDC contract
// carrying exact from (sender) / to (destination) / value (amount). An
// arbitrary transfer, a foreign-contract event, or client-supplied amounts
// can never satisfy all of these simultaneously.
export async function confirmSaveChallenge(args: {
  userToken: string;
  intent: UserSaveIntent;
  challengeId: string;
}): Promise<{ txHash: string }> {
  if (!args.intent.pendingChallengeId || args.intent.pendingChallengeId !== args.challengeId) {
    throw Object.assign(
      new Error("That challenge does not belong to this savings step — start the step again."),
      { status: 409, code: "CHALLENGE_MISMATCH" }
    );
  }
  const progress = await pollChallengeToTx({
    userToken: args.userToken,
    challengeId: args.intent.pendingChallengeId,
  });
  if (progress.kind === "executing") {
    throw Object.assign(
      new Error("Challenge still pending — approve it in the Circle prompt, then continue."),
      { status: 409, code: "CHALLENGE_PENDING" }
    );
  }
  if (progress.kind === "confirming") {
    throw Object.assign(
      new Error("Transaction submitted — waiting for on-chain confirmation, then continue."),
      { status: 409, code: "TX_CONFIRMING" }
    );
  }
  if (progress.kind === "failed") {
    throw Object.assign(new Error(progress.error ?? "Challenge failed."), {
      status: 409,
      code: "CHALLENGE_FAILED",
    });
  }
  const txHash = progress.txHash;
  if (!txHash) {
    throw Object.assign(
      new Error("Challenge confirmed but the transaction hash is not indexed yet — continue shortly."),
      { status: 409, code: "TX_CONFIRMING" }
    );
  }
  await verifySaveReceipt(txHash, {
    tokenAddress: args.intent.tokenAddress,
    sender: args.intent.senderAddress,
    destination: args.intent.destinationAddress,
    amount: BigInt(args.intent.amountMinor),
  });
  return { txHash };
}

export async function verifySaveReceipt(
  txHash: string,
  expect: {
    tokenAddress: string;
    sender: `0x${string}`;
    destination: `0x${string}`;
    amount: bigint;
  }
): Promise<{ txHash: string }> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw Object.assign(new Error("Not a valid transaction hash."), {
      status: 400,
      code: "INVALID_TX_HASH",
    });
  }
  const client = getPublicClient();
  const { decodeEventLog } = await import("viem");
  const receipt = await client
    .getTransactionReceipt({ hash: txHash as `0x${string}` })
    .catch(() => null);
  if (!receipt) {
    throw Object.assign(
      new Error("Savings transaction not found on Arc (or not yet confirmed)."),
      { status: 409, code: "SAVE_NOT_FOUND" }
    );
  }
  if (receipt.status !== "success") {
    throw Object.assign(new Error("Savings transaction reverted on-chain."), {
      status: 409,
      code: "SAVE_REVERTED",
    });
  }
  if (!receipt.to || receipt.to.toLowerCase() !== expect.tokenAddress.toLowerCase()) {
    throw Object.assign(new Error("Transaction was not sent to the USDC contract."), {
      status: 409,
      code: "SAVE_WRONG_TARGET",
    });
  }
  let matched = false;
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== expect.tokenAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: TRANSFER_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const e = decoded.args as { from: string; to: string; value: bigint };
      if (
        String(e.from).toLowerCase() === expect.sender.toLowerCase() &&
        String(e.to).toLowerCase() === expect.destination.toLowerCase() &&
        BigInt(e.value) === expect.amount
      ) {
        matched = true;
        break;
      }
    } catch {
      // not a decodable Transfer log
    }
  }
  if (!matched) {
    throw Object.assign(
      new Error(
        "No USDC Transfer event for the exact sender/destination/amount found in this transaction."
      ),
      { status: 409, code: "SAVE_EVENT_MISMATCH" }
    );
  }
  return { txHash };
}
