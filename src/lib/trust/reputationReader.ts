// src/lib/trust/reputationReader.ts
// On-chain ERC-8004 ReputationRegistry reads — write was already live, reads were missing.
// Uses the deployed ReputationRegistry via publicClient.readContract (no Circle SDK needed).
// Do NOT introduce a second registry.

import { createPublicClient, http } from "viem";

const REPUTATION_REGISTRY = (process.env.REPUTATION_REGISTRY_ADDRESS || "0x8004B663056A597Dffe9eCcC1965A193B7388713") as `0x${string}`;
const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network"] } },
} as const;

const REPUTATION_ABI = [
  { name: "getReputation", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "int128" }] },
  // Some deployments expose getFeedbacks; we try multiple read shapes and fall back gracefully
  { name: "getFeedbacks", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "tuple[]", components: [{ name: "clientAddress", type: "address" },{ name: "value", type: "int8" },{ name: "tag", type: "string" }] }] },
  { name: "feedbackCount", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "getFeedback", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" },{ name: "index", type: "uint256" }], outputs: [{ name: "client", type: "address" },{ name: "value", type: "int8" },{ name: "tag", type: "string" },{ name: "endpoint", type: "string" },{ name: "feedbackType", type: "uint8" }] },
] as const;

let _publicClient: any = null;
function getPublicClient(): any {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({ chain: arcTestnet as any, transport: http(process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network") });
  return _publicClient;
}

export interface ReputationSummary {
  tokenId: string;
  reputationScore: number | null; // int128 from contract, null if read failed
  reputationCount: number | null;
  positiveCount: number | null;
  negativeCount: number | null;
  recentFeedback: Array<{ client: string; value: number; tag: string }>;
  registryAddress: string;
  readOk: boolean;
  error?: string;
}

export async function readOnChainReputation(tokenId: string | bigint): Promise<ReputationSummary> {
  const tid = typeof tokenId === "string" ? BigInt(tokenId) : tokenId;
  const tidStr = tid.toString();
  const pc = getPublicClient() as any;
  let reputationScore: number | null = null;
  let reputationCount: number | null = null;
  let positiveCount: number | null = null;
  let negativeCount: number | null = null;
  let recentFeedback: ReputationSummary["recentFeedback"] = [];
  let readOk = false;
  let error: string | undefined;

  // Primary read: getReputation(tokenId) -> int128
  try {
    const raw = await pc.readContract({ address: REPUTATION_REGISTRY, abi: [{ name: "getReputation", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "int128" }] } as const], functionName: "getReputation", args: [tid] });
    reputationScore = Number(raw);
    readOk = true;
  } catch (e: any) {
    error = e?.message || String(e);
    // Not fatal — keep trying other reads if available
  }

  // Optional reads: feedback enumeration (best-effort, contract may not expose)
  // Try feedbackCount + getFeedback loop (up to 20)
  try {
    const count = await pc.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION_ABI as any, functionName: "feedbackCount", args: [tid] }) as bigint;
    reputationCount = Number(count);
    if (reputationCount > 0) {
      const take = Math.min(reputationCount, 10);
      const start = Math.max(0, reputationCount - take);
      for (let i = reputationCount - 1; i >= start; i--) {
        try {
          const fb = await pc.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION_ABI as any, functionName: "getFeedback", args: [tid, BigInt(i)] }) as any;
          const val = Number(fb?.value ?? fb?.[1] ?? 0);
          if (val > 0) positiveCount = (positiveCount ?? 0) + 1;
          else if (val < 0) negativeCount = (negativeCount ?? 0) + 1;
          recentFeedback.push({ client: String(fb?.client ?? fb?.[0] ?? ""), value: val, tag: String(fb?.tag ?? fb?.[2] ?? "") });
        } catch {}
      }
      readOk = true;
    } else {
      reputationCount = 0;
      positiveCount = 0;
      negativeCount = 0;
    }
  } catch {
    // feedbackCount not available — leave nulls, not an error
  }

  // If we never succeeded at any read, keep error
  if (!readOk && !error) error = "reputation read unavailable";

  return { tokenId: tidStr, reputationScore, reputationCount, positiveCount, negativeCount, recentFeedback, registryAddress: REPUTATION_REGISTRY, readOk, error: readOk ? undefined : error };
}
