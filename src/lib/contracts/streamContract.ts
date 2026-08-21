// src/lib/contracts/streamContract.ts
//
// Single source of truth for the ArcFlareStream contract on Arc Testnet:
// address + ABI + ethers read helpers. The ABI below is generated from
// contracts/ArcFlareStream.sol (the canonical implementation, compiled with
// solc 0.8.24 / OpenZeppelin 5.0.2). Deployed 2026-08-20:
//   0xd8ca3Bbc212F36666145fAa487D45742eA04A52B
//   tx 0x13a3879bcd6dd9ad9f97230f1cd25af949116a468b7e4bc67b7749909cad3009
// Bytecode verified live against the local artifact (keccak match).
//
// Writes are executed by the app's routes via Circle createContractTransaction
// (the poster's Circle SCA signs — it pays gas itself); this module only
// exposes READ helpers over ethers, plus the ABI used for event parsing.

import { Contract, JsonRpcProvider, id as keccakId } from "ethers";

export const ARC_FLARE_STREAM_CONTRACT_ADDRESS =
  process.env.ARC_FLARE_STREAM_CONTRACT_ADDRESS ?? "";

export const ARC_FLARE_STREAM_ABI = [
  "function openStream(address worker, address token, uint256 totalBudget, uint256 trancheCount) external returns (uint256 streamId)",
  "function releaseTranche(uint256 streamId, uint256 requirementIndex) external",
  "function closeStream(uint256 streamId) external",
  "function getStream(uint256 streamId) external view returns (tuple(address poster,address worker,address token,uint256 totalBudget,uint256 trancheCount,uint256 tranchesReleased,uint256 totalReleased,bool closed,uint64 openedAt))",
  "function releasedTranches(uint256 streamId, uint256 requirementIndex) external view returns (bool)",
  "function trancheAmounts(uint256 streamId, uint256 requirementIndex) external view returns (uint256)",
  "function nextStreamId() external view returns (uint256)",
  "event StreamOpened(uint256 indexed streamId, address indexed poster, address indexed worker, address token, uint256 totalBudget, uint256 trancheCount)",
  "event TrancheReleased(uint256 indexed streamId, uint256 indexed requirementIndex, uint256 amount)",
  "event StreamClosed(uint256 indexed streamId, uint256 totalReleased, uint256 remainderToWorker)",
] as const;

export interface StreamOnChainState {
  poster: string;
  worker: string;
  token: string;
  totalBudget: bigint;
  trancheCount: bigint;
  tranchesReleased: bigint;
  totalReleased: bigint;
  closed: boolean;
  openedAt: bigint;
}

const ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network";

let cachedProvider: JsonRpcProvider | null = null;

export function getStreamProvider(): JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new JsonRpcProvider(ARC_TESTNET_RPC_URL);
  }
  return cachedProvider;
}

function requireAddress(): string {
  if (!ARC_FLARE_STREAM_CONTRACT_ADDRESS) {
    throw new Error(
      "ARC_FLARE_STREAM_CONTRACT_ADDRESS is not configured — deploy ArcFlareStream.sol first"
    );
  }
  return ARC_FLARE_STREAM_CONTRACT_ADDRESS;
}

/**
 * Reads the full on-chain state of a stream (poster, worker, token, budget,
 * tranche bookkeeping). Used by the status route and the recovery path.
 */
export async function readStreamOnChain(streamId: bigint): Promise<StreamOnChainState> {
  const contract = new Contract(requireAddress(), ARC_FLARE_STREAM_ABI, getStreamProvider());
  const s = await contract.getStream(streamId);
  return {
    poster: s.poster as string,
    worker: s.worker as string,
    token: s.token as string,
    totalBudget: BigInt(s.totalBudget),
    trancheCount: BigInt(s.trancheCount),
    tranchesReleased: BigInt(s.tranchesReleased),
    totalReleased: BigInt(s.totalReleased),
    closed: s.closed as boolean,
    openedAt: BigInt(s.openedAt),
  };
}

/**
 * The exact tranche amount the contract stores for a stream+index (the
 * authoritative value — the last index carries the modulo remainder).
 */
export async function readTrancheAmount(
  streamId: bigint,
  requirementIndex: number
): Promise<bigint> {
  const contract = new Contract(requireAddress(), ARC_FLARE_STREAM_ABI, getStreamProvider());
  return BigInt(await contract.trancheAmounts(streamId, requirementIndex));
}

/**
 * True if the given requirement index was already released on-chain.
 * Used to detect the "tx landed but the DB write was lost" recovery case.
 */
export async function isTrancheReleasedOnChain(
  streamId: bigint,
  requirementIndex: number
): Promise<boolean> {
  const contract = new Contract(requireAddress(), ARC_FLARE_STREAM_ABI, getStreamProvider());
  return (await contract.releasedTranches(streamId, requirementIndex)) as boolean;
}

/**
 * Scans TrancheReleased events for a stream+index and returns the txHash of
 * the release that landed on-chain — the recovery path for a transaction
 * that succeeded but whose DB write failed (the route can then write the
 * missing tranche row with the REAL hash instead of double-paying).
 */
export async function findTrancheReleaseTxHash(
  streamId: bigint,
  requirementIndex: number
): Promise<string | null> {
  const provider = getStreamProvider();
  const filter = {
    address: requireAddress(),
    fromBlock: 0,
    toBlock: "latest",
    topics: [keccakId("TrancheReleased(uint256,uint256,uint256)")],
  };
  const logs = await provider.getLogs(filter);
  const iface = new Contract(requireAddress(), ARC_FLARE_STREAM_ABI, provider).interface;
  for (const log of logs) {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (
      parsed &&
      parsed.name === "TrancheReleased" &&
      BigInt(parsed.args.streamId) === streamId &&
      BigInt(parsed.args.requirementIndex) === BigInt(requirementIndex)
    ) {
      return log.transactionHash;
    }
  }
  return null;
}

/**
 * Deterministic tranche allocation, mirroring the contract exactly:
 * floor(totalBudget / trancheCount), with any remainder added to the LAST
 * tranche. Pure bigint math — no floating point anywhere.
 */
export function computeTrancheAmounts(
  totalBudget: bigint,
  trancheCount: number
): bigint[] {
  if (trancheCount <= 0) throw new Error("trancheCount must be positive");
  const base = totalBudget / BigInt(trancheCount);
  const remainder = totalBudget % BigInt(trancheCount);
  const amounts: bigint[] = [];
  for (let i = 0; i < trancheCount; i++) {
    amounts.push(base + (i === trancheCount - 1 ? remainder : 0n));
  }
  return amounts;
}