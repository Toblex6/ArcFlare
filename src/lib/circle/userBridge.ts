// src/lib/circle/userBridge.ts
//
// Server-side USER_CONTROLLED CCTP bridge orchestration: the server builds
// every byte of calldata (via cctpChallenge.ts), creates Circle challenges
// via REST, and verifies mined receipts — the BROWSER only executes each
// challengeId through the Web SDK (setAuthentication -> execute).
//
// Custody discipline (same as userControlled.ts): this module NEVER sees,
// stores, or transports private keys or user key material. The per-request
// `userToken` arrives in the request body, is passed through as X-User-Token,
// and is never logged or persisted. Challenge execution (signing) happens
// exclusively in the browser.
//
// Flow per bridge:
//   1. POST /api/cctp/transfer { fromChain, toChain, amount, recipient,
//      userToken } → resolves the user's source-chain wallet, checks the
//      TokenMessenger allowance via eth_call, and returns either
//      { state: 'needs-provision', challengeId } (wallet missing on the
//      source chain), { state: 'needs-approval', challengeId, reference },
//      or { state: 'needs-burn', challengeId, reference }.
//   2. Browser executes the challengeId, then POSTs
//      /api/cctp/transfer/challenge { reference, challengeId, userToken }.
//      The server polls the challenge → Circle tx → mined receipt:
//        - approve confirmed → fresh burn challenge (same call shape).
//        - burn confirmed → burn receipt verified (Pattern A) → the intent
//          moves to 'minting' and the Arc balance baseline is recorded.
//   3. GET /api/cctp/transfer/status?reference=… polls the Arc balance
//      delta (recipient credited ≥ amount − maxFee) — the destination mint
//      needs nothing from the wallet (Circle's relayer completes it).
//
// Server-only: importing this module in a browser bundle throws (same rule
// as userControlled.ts) so CIRCLE_API_KEY can never leak client-side.
//
// Process-local intent store: same limitation as cctp-v2.ts pendingTransfers
// (single long-running instance; does not survive restart). A restart loses
// in-flight UC bridges — the browser simply starts over (no funds move
// until the user executes a challenge, so a lost intent is safe).

import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  type Hash,
  type Hex,
} from "viem";
import {
  ArbitrumSepolia,
  BaseSepolia,
  EthereumSepolia,
  OptimismSepolia,
  PolygonAmoy,
} from "@circle-fin/bridge-kit";
import { getNetworkConfig } from "@/lib/config/network";
import { getPublicClient } from "@/lib/wallet/chainClient";
import {
  CCTP_V2_TOKEN_MESSENGER,
  addressToBytes32,
  assertArcDestinationOverlap,
  encodeApproveCallData,
  encodeDepositForBurnCallData,
  resolveSourceChainBinding,
  type CctpSourceChainId,
} from "@/lib/circle/cctpChallenge";
import {
  createUserContractExecutionChallenge,
  createUserWalletOnChainChallenge,
  getUserChallenge,
  getUserTransaction,
  isCircleTxComplete,
  isCircleTxTerminalFailure,
  listUserControlledWallets,
  type CircleUserWallet,
} from "@/lib/circle/userControlled";

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/circle/userBridge.ts is server-only (it carries CIRCLE_API_KEY) and must never be bundled for the browser."
  );
}

const ERC20_MIN_ABI = [
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// DepositForBurn event (CCTP v2 TokenMessenger) — field order verified
// against the installed @circle-fin/adapter-viem-v2 package. Used for
// receipt proof: event emitted by the TokenMessenger, exact amount,
// exact destinationDomain, exact mintRecipient.
const DEPOSIT_FOR_BURN_EVENT_ABI = [
  {
    type: "event",
    name: "DepositForBurn",
    inputs: [
      { name: "burnToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "depositor", type: "address", indexed: true },
      { name: "mintRecipient", type: "bytes32", indexed: false },
      { name: "destinationDomain", type: "uint32", indexed: false },
      { name: "destinationTokenMessenger", type: "bytes32", indexed: false },
      { name: "destinationCaller", type: "bytes32", indexed: false },
      { name: "maxFee", type: "uint256", indexed: false },
      { name: "minFinalityThreshold", type: "uint32", indexed: true },
      { name: "hookData", type: "bytes", indexed: false },
    ],
  },
] as const;

// ── Source-chain reads ──────────────────────────────────────────────────────
// Bridge-kit chain objects are authoritative for chainId + rpcEndpoints.
// Single-RPC with short retries (source chains are public testnets; the
// multi-RPC reliable pattern of chainClient.ts is Arc-specific).

async function withRetries<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Source-chain ${label} failed.`);
}

const SOURCE_KIT_CHAINS: Record<CctpSourceChainId, any> = {
  Arbitrum_Sepolia: ArbitrumSepolia,
  Base_Sepolia: BaseSepolia,
  Ethereum_Sepolia: EthereumSepolia,
  Optimism_Sepolia: OptimismSepolia,
  Polygon_Amoy_Testnet: PolygonAmoy,
};

export function getSourceChainClient(sourceId: CctpSourceChainId) {
  // Bridge-kit is the authority for the source chain's id + RPCs — never a
  // local copy.
  const chainObj = SOURCE_KIT_CHAINS[sourceId];
  if (!chainObj || typeof chainObj.chainId !== "number" || !Array.isArray(chainObj.rpcEndpoints)) {
    throw Object.assign(new Error(`Bridge-kit has no chain definition for ${sourceId}.`), {
      status: 502,
      code: "SOURCE_CHAIN_UNKNOWN",
    });
  }
  const chain = defineChain({
    id: chainObj.chainId,
    name: chainObj.name ?? sourceId,
    nativeCurrency: chainObj.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: chainObj.rpcEndpoints } },
    testnet: true,
  });
  return createPublicClient({ chain, transport: http(chainObj.rpcEndpoints[0]) });
}

export async function readSourceAllowance(args: {
  sourceId: CctpSourceChainId;
  usdc: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
}): Promise<bigint> {
  const client = getSourceChainClient(args.sourceId);
  return withRetries("allowance read", () =>
    client.readContract({
      address: args.usdc,
      abi: ERC20_MIN_ABI,
      functionName: "allowance",
      args: [args.owner, args.spender],
    })
  );
}

export async function readSourceUsdcBalance(args: {
  sourceId: CctpSourceChainId;
  usdc: `0x${string}`;
  owner: `0x${string}`;
}): Promise<bigint> {
  const client = getSourceChainClient(args.sourceId);
  return withRetries("balance read", () =>
    client.readContract({
      address: args.usdc,
      abi: ERC20_MIN_ABI,
      functionName: "balanceOf",
      args: [args.owner],
    })
  );
}

// ── Burn receipt verification (Pattern A, source chain) ─────────────────────
// Proves the mined tx really was OUR burn: receipt exists + success,
// receipt.to === TokenMessenger, receipt.from === sender, and a
// DepositForBurn event from the TokenMessenger carrying the exact amount,
// exact destinationDomain, and exact mintRecipient (bytes32). An arbitrary
// transfer, a foreign-router event, or client-supplied amounts can never
// satisfy all of these simultaneously.
export interface BurnExpectation {
  sourceId: CctpSourceChainId;
  tokenMessenger: `0x${string}`;
  sender: `0x${string}`;
  amount: bigint;
  destinationDomain: number;
  mintRecipient: `0x${string}`;
}

export async function verifyBurnReceipt(
  txHash: string,
  expect: BurnExpectation
): Promise<{ txHash: string }> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw Object.assign(new Error("Not a valid transaction hash."), {
      status: 400,
      code: "INVALID_TX_HASH",
    });
  }
  const client = getSourceChainClient(expect.sourceId);
  const receipt = await withRetries("burn receipt read", () =>
    client.getTransactionReceipt({ hash: txHash as Hash })
  ).catch(() => null);
  if (!receipt) {
    throw Object.assign(
      new Error("Burn transaction not found on the source chain (or not yet confirmed)."),
      { status: 409, code: "BURN_NOT_FOUND" }
    );
  }
  if (receipt.status !== "success") {
    throw Object.assign(new Error("Burn transaction reverted on-chain."), {
      status: 409,
      code: "BURN_REVERTED",
    });
  }
  if (!receipt.to || receipt.to.toLowerCase() !== expect.tokenMessenger.toLowerCase()) {
    throw Object.assign(new Error("Transaction was not sent to the TokenMessenger."), {
      status: 409,
      code: "BURN_WRONG_TARGET",
    });
  }
  if (receipt.from.toLowerCase() !== expect.sender.toLowerCase()) {
    throw Object.assign(new Error("Burn was not sent from the bridge wallet."), {
      status: 409,
      code: "BURN_WRONG_SENDER",
    });
  }
  const expectedRecipient = addressToBytes32(expect.mintRecipient).toLowerCase();
  let matched = false;
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== expect.tokenMessenger.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: DEPOSIT_FOR_BURN_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "DepositForBurn") continue;
      const e = decoded.args as {
        amount: bigint;
        mintRecipient: Hex;
        destinationDomain: number;
      };
      if (
        e.amount === expect.amount &&
        String(e.mintRecipient).toLowerCase() === expectedRecipient &&
        Number(e.destinationDomain) === expect.destinationDomain
      ) {
        matched = true;
        break;
      }
    } catch {
      // not a decodable DepositForBurn log
    }
  }
  if (!matched) {
    throw Object.assign(
      new Error(
        "No DepositForBurn event for the exact amount/destination/recipient found in this transaction."
      ),
      { status: 409, code: "BURN_EVENT_MISMATCH" }
    );
  }
  return { txHash };
}

// ── Intent store ────────────────────────────────────────────────────────────

export type UserBridgeState =
  | "needs-approval"
  | "needs-burn"
  | "executing"
  | "confirming"
  | "minting"
  | "success"
  | "error";

export interface UserBridgeIntent {
  reference: string;
  state: UserBridgeState;
  fromChain: CctpSourceChainId;
  toChain: string;
  // 6-dec minor units, stored as decimal strings (bigint-safe JSON).
  amountMinor: string;
  maxFeeMinor: string;
  minFinalityThreshold: number;
  senderAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  sourceDomain: number;
  destinationDomain: number;
  tokenMessenger: `0x${string}`;
  usdcAddress: `0x${string}`;
  circleBlockchain: string;
  walletId: string;
  pendingChallengeId: string | null;
  pendingPurpose: "provision" | "approve" | "burn" | null;
  burnTxHash: string | null;
  // Arc USDC balance of the recipient before the burn was verified (6-dec
  // minor units, decimal string) — the minting baseline for balance-delta.
  balanceBeforeMinor: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const userBridgeIntents = new Map<string, UserBridgeIntent>();

function makeReference(): string {
  return `ucbridge_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

export function getUserBridgeIntent(reference: string): UserBridgeIntent | null {
  return userBridgeIntents.get(reference) ?? null;
}

export function setUserBridgeIntent(intent: UserBridgeIntent): void {
  intent.updatedAt = Date.now();
  userBridgeIntents.set(intent.reference, intent);
}

// ── Wallet resolution ───────────────────────────────────────────────────────
// Trust anchor: only addresses Circle returns for THIS userToken may bridge.
// The session address must be among them (fail closed otherwise — Circle
// SCAs share an address across chains, so a divergence means corruption).
// Returns the source-chain wallet resource (walletId for challenges).
export async function resolveUserSourceWallet(args: {
  userToken: string;
  sessionAddress: string;
  circleBlockchain: string;
}): Promise<{ wallet: CircleUserWallet; allWallets: CircleUserWallet[] }> {
  const wallets = await listUserControlledWallets(args.userToken);
  const session = args.sessionAddress.toLowerCase();
  const owned = wallets.filter((w) => w.address.toLowerCase() === session);
  if (owned.length === 0) {
    throw Object.assign(
      new Error("This wallet does not belong to the authenticated Circle identity."),
      { status: 403, code: "CIRCLE_WALLET_MISMATCH" }
    );
  }
  // Same address across chains by construction — assert it anyway so a
  // future Circle divergence fails closed instead of bridging from a
  // wallet the session does not own.
  const onSource = owned.find(
    (w) => w.blockchain?.toUpperCase() === args.circleBlockchain.toUpperCase()
  );
  if (!onSource) {
    throw Object.assign(
      new Error(`WALLET_NOT_ON_CHAIN:${args.circleBlockchain}`),
      { status: 409, code: "WALLET_NOT_ON_CHAIN" }
    );
  }
  return { wallet: onSource, allWallets: wallets };
}

// ── Challenge builders ──────────────────────────────────────────────────────

export interface BridgeQuote {
  binding: {
    sourceId: CctpSourceChainId;
    usdcAddress: `0x${string}`;
    tokenMessenger: `0x${string}`;
    sourceDomain: number;
  };
  destinationDomain: number;
  amountMinor: bigint;
  maxFeeMinor: bigint;
  minFinalityThreshold: number;
}

// Validate the human amount string into 6-dec minor units and bind every
// server-trusted value for the bridge (source binding from bridge-kit,
// destination domain from network config with overlap assertion).
export function buildBridgeQuote(args: {
  fromChain: string;
  amount: string;
}): BridgeQuote {
  const binding = resolveSourceChainBinding(args.fromChain);
  const { destinationDomain } = assertArcDestinationOverlap();
  const raw = String(args.amount ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw Object.assign(
      new Error("Amount must be a positive USDC value with at most 6 decimals."),
      { status: 400, code: "INVALID_AMOUNT" }
    );
  }
  const [whole, frac = ""] = raw.split(".");
  const amountMinor = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  if (amountMinor <= 0n) {
    throw Object.assign(new Error("Amount must be positive."), {
      status: 400,
      code: "INVALID_AMOUNT",
    });
  }
  // SLOW path only in this phase (maxFee 0 — no Iris dependency, no fee
  // deduction surprise). FAST pricing arrives with the fee-tier work.
  return {
    binding,
    destinationDomain,
    amountMinor,
    maxFeeMinor: 0n,
    minFinalityThreshold: 2000,
  };
}

export async function createApproveChallenge(args: {
  userToken: string;
  walletId: string;
  circleBlockchain: string;
  tokenMessenger: `0x${string}`;
  usdcAddress: `0x${string}`;
  amountMinor: bigint;
  refId?: string;
}): Promise<{ challengeId: string }> {
  return createUserContractExecutionChallenge(args.userToken, {
    contractAddress: args.usdcAddress,
    callData: encodeApproveCallData({ spender: args.tokenMessenger, amount: args.amountMinor }),
    blockchain: args.circleBlockchain,
    walletId: args.walletId,
    feeLevel: "MEDIUM",
    ...(args.refId ? { refId: args.refId } : {}),
  });
}

export async function createBurnChallenge(args: {
  userToken: string;
  walletId: string;
  circleBlockchain: string;
  quote: BridgeQuote;
  mintRecipient: `0x${string}`;
  refId?: string;
}): Promise<{ challengeId: string }> {
  return createUserContractExecutionChallenge(args.userToken, {
    contractAddress: args.quote.binding.tokenMessenger,
    callData: encodeDepositForBurnCallData({
      amount: args.quote.amountMinor,
      destinationDomain: args.quote.destinationDomain,
      mintRecipient: args.mintRecipient,
      burnToken: args.quote.binding.usdcAddress,
      maxFee: args.quote.maxFeeMinor,
      minFinalityThreshold: args.quote.minFinalityThreshold,
    }),
    blockchain: args.circleBlockchain,
    walletId: args.walletId,
    feeLevel: "MEDIUM",
    ...(args.refId ? { refId: args.refId } : {}),
  });
}

export async function createProvisionChallenge(args: {
  userToken: string;
  circleBlockchain: string;
}): Promise<{ challengeId: string }> {
  return createUserWalletOnChainChallenge(args.userToken, [args.circleBlockchain]);
}

// ── Continue-step polling ───────────────────────────────────────────────────
// One pass over challenge → Circle tx. Returns a non-terminal marker when
// Circle is still working so the browser retries (idempotent — safe to
// call again with the same challengeId).

export interface ChallengeProgress {
  kind: "executing" | "confirming" | "confirmed" | "failed";
  challengeStatus?: string;
  txState?: string;
  txId?: string;
  txHash?: string;
  error?: string;
}

export async function pollChallengeToTx(args: {
  userToken: string;
  challengeId: string;
}): Promise<ChallengeProgress> {
  const { challenge } = await getUserChallenge(args.userToken, args.challengeId);
  const status = String(challenge?.status ?? "").toUpperCase();
  if (status === "COMPLETE") {
    const txId = Array.isArray(challenge?.correlationIds)
      ? String(challenge.correlationIds[0] ?? "")
      : "";
    if (!txId) {
      return { kind: "confirming", challengeStatus: status };
    }
    const tx = await getUserTransaction(txId, args.userToken);
    const txState = String(tx?.state ?? "").toUpperCase();
    if (isCircleTxComplete(tx?.state)) {
      return { kind: "confirmed", challengeStatus: status, txState, txId, txHash: tx?.txHash };
    }
    if (isCircleTxTerminalFailure(tx?.state)) {
      return {
        kind: "failed",
        challengeStatus: status,
        txState,
        txId,
        error: `Circle transaction ${txState.toLowerCase()} — nothing was broadcast from your wallet for this step.`,
      };
    }
    return { kind: "confirming", challengeStatus: status, txState, txId };
  }
  if (status === "FAILED" || status === "EXPIRED") {
    const detail = [challenge?.errorCode, challenge?.errorMessage].filter(Boolean).join(" ");
    return {
      kind: "failed",
      challengeStatus: status,
      error: `Circle challenge ${status.toLowerCase()}${detail ? ` (${detail})` : ""} — try this step again.`,
    };
  }
  return { kind: "executing", challengeStatus: status || "PENDING" };
}

// ── Arc mint polling (balance-delta) ────────────────────────────────────────
// The destination mint needs nothing from the wallet — success is observed
// as recipient USDC balance growth ≥ amount − maxFee over the baseline
// recorded when the burn was verified. Reads Arc via the standard client.

export async function readArcUsdcBalanceOf(owner: `0x${string}`): Promise<bigint> {
  const net = getNetworkConfig();
  const client = getPublicClient();
  const result = await client.readContract({
    address: getAddress(net.usdcAddress) as `0x${string}`,
    abi: ERC20_MIN_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  return result as bigint;
}

export function minorToDisplay(minor: bigint): string {
  const neg = minor < 0n;
  const v = neg ? -minor : minor;
  const whole = v / 1_000_000n;
  const frac = String(v % 1_000_000n).padStart(6, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export { CCTP_V2_TOKEN_MESSENGER, makeReference as makeUserBridgeReference };
// Re-exported so routes import the whole UC bridge surface from this one
// module (single import site per route); authority stays in cctpChallenge.
export {
  assertArcDestinationOverlap,
  resolveSourceChainBinding,
  type CctpSourceChainId,
} from "@/lib/circle/cctpChallenge";
