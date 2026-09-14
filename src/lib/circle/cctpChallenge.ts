// src/lib/circle/cctpChallenge.ts
//
// Pure CCTP v2 encoding helpers for the USER_CONTROLLED bridge path
// (server-orchestrated, browser-executed burn). No RPC, no DB, no secrets
// at import time — every function here is a pure function over its inputs,
// so the adversarial cases run without funds.
//
// Encoding mirror (1:1 with @circle-fin/adapter-viem-v2 internals):
//   depositForBurn on the source chain's TokenMessenger
//     (0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA on all listed testnet EVM
//     sources), args in order:
//     [amount (uint256, 6-dec minor units),
//      destinationDomain (uint32),
//      mintRecipient (bytes32 — address left-padded),
//      burnToken (address — the source chain's USDC),
//      destinationCaller (bytes32 — ZERO_HASH for the standard path),
//      maxFee (uint256),
//      minFinalityThreshold (uint32: FAST=1000, SLOW=2000)]
//   approve challenge: standard approve(address spender, uint256 amount) on
//     the source chain's USDC contract, spender = TokenMessenger,
//     amount = burn amount (+ custom fee if used).
//
// Why only the source chain needs signing: bridge-kit's ArcTestnet chain
// config carries forwarderSupported { source: false, destination: true } —
// the Arc-side mint needs no destination signature (Circle's relayer
// completes it). So only the source-chain approve + depositForBurn need
// browser-executed challenges.
//
// maxFee is the CCTP message fee deducted from the burned amount — NOT gas.
// Distinct from Circle's feeLevel/gasLimit challenge params. SLOW (2000)
// without a forwarder means maxFee 0. FAST fee formula (from
// provider-cctp-v2): fetch {iris}/{v2}/burn/USDC/fees/{srcDomain}/
// {dstDomain}, take the tier with finalityThreshold === 1000,
// scaledBps = round(minimumFee * 100) (minimumFee is a bps decimal, e.g.
// "1.3"), baseFee = ceilDiv(scaledBps * amount, 1_000_000),
// providerFee = baseFee + baseFee/10n (10% buffer). maxFee = providerFee
// (+ forwarderFee when the relayer-forwarded path is used).
//
// Forwarding hookData (depositForBurnWithHook only): 32 bytes = the ASCII
// "cctp-forward" right-padded to 24 bytes + uint32 BE version 0 (bytes
// 24-27) + uint32 BE length 0 (bytes 28-31). NOT used: the plain burn +
// Circle relayer attestation already round-trips to Arc, and every listed
// source has forwarderSupported.source === false.

import { encodeFunctionData, getAddress, pad, type Hex } from "viem";
import {
  ArbitrumSepolia,
  BaseSepolia,
  EthereumSepolia,
  OptimismSepolia,
  PolygonAmoy,
  ArcTestnet,
} from "@circle-fin/bridge-kit";
import { getNetworkConfig } from "@/lib/config/network";

// ── CCTP v2 finality thresholds ─────────────────────────────────────────────
export const CCTP_FINALITY_FAST = 1000;
export const CCTP_FINALITY_SLOW = 2000;

// Standard-path destinationCaller: anyone may complete the mint.
export const CCTP_ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

// Canonical v2 TokenMessenger shared by every listed testnet EVM source.
export const CCTP_V2_TOKEN_MESSENGER =
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;

// Minimal ABIs for the two challenged calls (encode-only, no reads).
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const DEPOSIT_FOR_BURN_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── Source-chain registry (bridge-kit is authoritative) ─────────────────────
// Keyed by the same `id` values getCctpSources() uses (BridgeChain enum
// members). Each entry is the bridge-kit exported chain object — usdcAddress,
// cctp.domain, cctp.contracts.v2.tokenMessenger and forwarderSupported all
// come from Circle's package, never from a local copy.
const SOURCE_CHAINS = {
  Arbitrum_Sepolia: ArbitrumSepolia,
  Base_Sepolia: BaseSepolia,
  Ethereum_Sepolia: EthereumSepolia,
  Optimism_Sepolia: OptimismSepolia,
  Polygon_Amoy_Testnet: PolygonAmoy,
} as const;

export type CctpSourceChainId = keyof typeof SOURCE_CHAINS;

export function isCctpSourceChainId(id: string): id is CctpSourceChainId {
  return Object.prototype.hasOwnProperty.call(SOURCE_CHAINS, id);
}

export interface SourceChainBinding {
  sourceId: CctpSourceChainId;
  usdcAddress: `0x${string}`;
  tokenMessenger: `0x${string}`;
  sourceDomain: number;
}

// Resolve the server-trusted source-chain binding. Throws (fail closed) on
// unknown chain ids. Also asserts the bridge-kit TokenMessenger matches the
// canonical v2 address — a bridge-kit upgrade that moved it must fail here,
// not silently challenge a foreign contract.
export function resolveSourceChainBinding(sourceId: string): SourceChainBinding {
  if (!isCctpSourceChainId(sourceId)) {
    throw Object.assign(new Error(`Unsupported CCTP source chain: ${sourceId}.`), {
      status: 400,
      code: "UNSUPPORTED_SOURCE_CHAIN",
    });
  }
  const chain = SOURCE_CHAINS[sourceId] as unknown as {
    usdcAddress: string;
    cctp: { domain: number; contracts: { v2: { tokenMessenger: string } } };
  };
  if (!chain.usdcAddress || !/^0x[0-9a-fA-F]{40}$/.test(chain.usdcAddress)) {
    throw Object.assign(
      new Error(`Bridge-kit has no USDC address for source chain ${sourceId}.`),
      { status: 502, code: "SOURCE_USDC_UNKNOWN" }
    );
  }
  const messenger = chain.cctp?.contracts?.v2?.tokenMessenger;
  if (
    !messenger ||
    messenger.toLowerCase() !== CCTP_V2_TOKEN_MESSENGER.toLowerCase()
  ) {
    throw Object.assign(
      new Error(
        `Bridge-kit TokenMessenger for ${sourceId} (${messenger ?? "missing"}) does not match the canonical CCTP v2 messenger — refusing to challenge a foreign contract.`
      ),
      { status: 502, code: "FOREIGN_TOKEN_MESSENGER" }
    );
  }
  return {
    sourceId,
    usdcAddress: getAddress(chain.usdcAddress),
    tokenMessenger: getAddress(messenger),
    sourceDomain: chain.cctp.domain,
  };
}

// Assert the bridge-kit ArcTestnet destination overlaps the authoritative
// network config (domain + MessageTransmitter). Never hardcode either side:
// a drift between the installed bridge-kit and network.ts fails closed.
export function assertArcDestinationOverlap(): {
  destinationDomain: number;
  messageTransmitter: `0x${string}`;
} {
  const net = getNetworkConfig();
  const kit = ArcTestnet as unknown as {
    cctp: { domain: number; contracts: { v2: { messageTransmitter: string } } };
  };
  if (kit.cctp?.domain !== net.cctpDomain) {
    throw Object.assign(
      new Error(
        `Bridge-kit Arc domain (${kit.cctp?.domain}) disagrees with network config (${net.cctpDomain}).`
      ),
      { status: 500, code: "CCTP_DOMAIN_DRIFT" }
    );
  }
  const kitMt = kit.cctp?.contracts?.v2?.messageTransmitter;
  if (!kitMt || kitMt.toLowerCase() !== net.cctpMessageTransmitter.toLowerCase()) {
    throw Object.assign(
      new Error(
        `Bridge-kit Arc MessageTransmitter (${kitMt ?? "missing"}) disagrees with network config (${net.cctpMessageTransmitter}).`
      ),
      { status: 500, code: "CCTP_MESSENGER_DRIFT" }
    );
  }
  return {
    destinationDomain: net.cctpDomain,
    messageTransmitter: getAddress(net.cctpMessageTransmitter),
  };
}

// ── Pure encodings ──────────────────────────────────────────────────────────

// EVM address -> bytes32 (left-padded) for mintRecipient/destinationCaller.
export function addressToBytes32(address: string): Hex {
  return pad(getAddress(address) as Hex, { size: 32 });
}

export function bytes32ToAddress(value: string): `0x${string}` {
  const v = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(v)) {
    throw Object.assign(new Error(`Not a bytes32 value: ${value}.`), {
      status: 400,
      code: "INVALID_BYTES32",
    });
  }
  return getAddress(`0x${v.slice(26)}`);
}

// Standard approve(spender, amount) calldata on the source USDC contract.
export function encodeApproveCallData(args: {
  spender: string;
  amount: bigint;
}): Hex {
  if (args.amount <= 0n) {
    throw Object.assign(new Error("Approve amount must be positive."), {
      status: 400,
      code: "INVALID_AMOUNT",
    });
  }
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [getAddress(args.spender), args.amount],
  });
}

export interface DepositForBurnArgs {
  // 6-dec minor units (canonical books everywhere).
  amount: bigint;
  destinationDomain: number;
  // Where minted USDC lands on Arc (plain address — padded inside).
  mintRecipient: string;
  burnToken: string;
  maxFee?: bigint;
  minFinalityThreshold?: number;
}

// depositForBurn calldata, args in canonical order. destinationCaller is
// always ZERO_HASH (standard path — anyone may complete the mint).
export function encodeDepositForBurnCallData(args: DepositForBurnArgs): Hex {
  if (args.amount <= 0n) {
    throw Object.assign(new Error("Burn amount must be positive."), {
      status: 400,
      code: "INVALID_AMOUNT",
    });
  }
  const maxFee = args.maxFee ?? 0n;
  if (maxFee < 0n || maxFee >= args.amount) {
    throw Object.assign(
      new Error("maxFee must be non-negative and strictly less than the burn amount."),
      { status: 400, code: "INVALID_MAX_FEE" }
    );
  }
  const finality = args.minFinalityThreshold ?? CCTP_FINALITY_SLOW;
  if (finality !== CCTP_FINALITY_FAST && finality !== CCTP_FINALITY_SLOW) {
    throw Object.assign(
      new Error(`minFinalityThreshold must be ${CCTP_FINALITY_FAST} (FAST) or ${CCTP_FINALITY_SLOW} (SLOW).`),
      { status: 400, code: "INVALID_FINALITY" }
    );
  }
  return encodeFunctionData({
    abi: DEPOSIT_FOR_BURN_ABI,
    functionName: "depositForBurn",
    args: [
      args.amount,
      args.destinationDomain,
      addressToBytes32(args.mintRecipient),
      getAddress(args.burnToken),
      CCTP_ZERO_HASH,
      maxFee,
      finality,
    ],
  });
}

// ── FAST maxFee computation (impure thin wrapper over the Iris fee API) ─────
// Formula (from provider-cctp-v2): take the tier with
// finalityThreshold === 1000, scaledBps = round(minimumFee * 100)
// (minimumFee is a bps decimal, e.g. "1.3"), baseFee =
// ceilDiv(scaledBps * amount, 1_000_000), providerFee = baseFee +
// baseFee/10n (10% buffer). SLOW (2000) without a forwarder means maxFee 0 —
// callers should skip this fetch entirely for the SLOW path.
export interface IrisFeeTier {
  finalityThreshold?: number;
  minimumFee?: string | number;
}

export function computeFastMaxFee(
  tiers: IrisFeeTier[],
  amount: bigint
): bigint {
  if (amount <= 0n) {
    throw Object.assign(new Error("Burn amount must be positive."), {
      status: 400,
      code: "INVALID_AMOUNT",
    });
  }
  const fast = (Array.isArray(tiers) ? tiers : []).find(
    (t) => t?.finalityThreshold === CCTP_FINALITY_FAST
  );
  if (!fast || fast.minimumFee === undefined || fast.minimumFee === null) {
    throw Object.assign(
      new Error("Iris fee schedule has no FAST (1000) tier — cannot price a FAST burn."),
      { status: 502, code: "CCTP_FEE_TIER_MISSING" }
    );
  }
  const minimumFee = Number(fast.minimumFee);
  if (!Number.isFinite(minimumFee) || minimumFee < 0) {
    throw Object.assign(
      new Error(`Iris FAST minimumFee is not a usable number (${String(fast.minimumFee)}).`),
      { status: 502, code: "CCTP_FEE_INVALID" }
    );
  }
  const scaledBps = BigInt(Math.round(minimumFee * 100));
  // ceilDiv(scaledBps * amount, 1_000_000)
  const baseFee = (scaledBps * amount + 1_000_000n - 1n) / 1_000_000n;
  const providerFee = baseFee + baseFee / 10n;
  if (providerFee >= amount) {
    throw Object.assign(
      new Error("Computed FAST maxFee covers the whole burn amount — refusing."),
      { status: 400, code: "INVALID_MAX_FEE" }
    );
  }
  return providerFee;
}

export async function fetchFastMaxFee(args: {
  sourceDomain: number;
  destinationDomain: number;
  amount: bigint;
  irisApiUrl?: string;
}): Promise<bigint> {
  const base = (args.irisApiUrl ?? getNetworkConfig().irisApiUrl).replace(/\/+$/, "");
  const url =
    `${base}/burn/USDC/fees/${args.sourceDomain}/${args.destinationDomain}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw Object.assign(
      new Error(`Iris fee schedule fetch failed (HTTP ${res.status}).`),
      { status: 502, code: "CCTP_FEE_FETCH_FAILED" }
    );
  }
  const data = await res.json().catch(() => ({}));
  const tiers: IrisFeeTier[] = Array.isArray((data as any)?.fees)
    ? (data as any).fees
    : Array.isArray(data)
      ? data
      : [];
  return computeFastMaxFee(tiers, args.amount);
}
