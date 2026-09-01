// src/lib/wallet/chainClient.ts
//
// Arc testnet RPC clients are flaky and out of sync with each other
// (documented repeatedly in AGENTS.md: ECONNRESET / bad record MAC /
// -32011 rate limits / nodes ~16 blocks apart / some nodes missing
// transactions that others serve). Verification of an external wallet's
// broadcast MUST NOT depend on a single node answering a receipt lookup.
//
// This module builds a viem PublicClient that:
//   - uses the primary RPC first (ARC_TESTNET_RPC), then
//   - falls back across the known-good alternates, and
//   - retries each attempt with backoff.
//
// It is read-only. Nothing here broadcasts a transaction.

import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
  type GetTransactionReceiptReturnType,
  type Transaction,
  type Hash,
  type Abi,
  type AbiFunction,
} from "viem";

export const chainId = 5042002;

const arcTestnet = defineChain({
  id: chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  testnet: true,
});

function candidateRpcUrls(): string[] {
  const urls = new Set<string>();
  const primary = process.env.ARC_TESTNET_RPC?.trim();
  if (primary) urls.add(primary);
  const fallbacks = (process.env.ARC_TESTNET_RPC_FALLBACKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of fallbacks) urls.add(f);
  // Known-good alternates (verified 2026-08-31 — they serve txs the primary
  // node misses). Order matters: primary first, then these.
  for (const alt of [
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
    "https://rpc.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
  ]) {
    urls.add(alt);
  }
  return [...urls];
}

export function getPublicClient(): PublicClient {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(candidateRpcUrls()[0]),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withBackoff<T>(
  attempts: number,
  fn: () => Promise<T>,
  isRetryable: (e: unknown) => boolean
): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      return result;
    } catch (e: any) {
      lastErr = e;
      const retryable = isRetryable(e);
      if (!retryable) return null;
      await sleep(500 * (i + 1) + Math.random() * 300);
    }
  }
  console.warn("[chainClient] all attempts failed:", (lastErr as any)?.message?.slice(0, 120));
  return null;
}

function isTransientRpcError(e: unknown): boolean {
  const msg = String((e as any)?.shortMessage || (e as any)?.message || e);
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("bad record MAC") ||
    msg.includes("TIMEOUT") ||
    msg.includes("timeout") ||
    msg.includes("-32011") ||
    msg.includes("rate limit") ||
    msg.includes("Bad Gateway") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("Socket") ||
    msg.includes("fetch failed")
  );
}

/**
 * Fetch a transaction receipt across every candidate RPC until one answers.
 * Returns the receipt or null when the tx is genuinely unknown everywhere.
 * A node that answers `null` for the hash is treated as "keep trying the
 * other nodes" — it may simply not have indexed that tx.
 */
export async function getReceiptReliable(
  txHash: string
): Promise<GetTransactionReceiptReturnType | null> {
  const urls = candidateRpcUrls();
  for (const url of urls) {
    const client = createPublicClient({ chain: arcTestnet, transport: http(url) });
    const receipt = await withBackoff<GetTransactionReceiptReturnType | null>(
      3,
      () => client.getTransactionReceipt({ hash: txHash as Hash }),
      isTransientRpcError
    );
    if (receipt) return receipt;
  }
  return null;
}

/**
 * Fetch the raw transaction (for the calldata selector) across every
 * candidate RPC. Returns the tx or null when unknown everywhere.
 */
export async function getTransactionReliable(txHash: string): Promise<Transaction | null> {
  const urls = candidateRpcUrls();
  for (const url of urls) {
    const client = createPublicClient({ chain: arcTestnet, transport: http(url) });
    const tx = await withBackoff<Transaction | null>(
      3,
      () => client.getTransaction({ hash: txHash as Hash }),
      isTransientRpcError
    );
    if (tx) return tx;
  }
  return null;
}

/**
 * Extract the 4-byte function selector from a transaction's calldata.
 * Returns null for value-only / no-input transactions.
 */
export function extractSelector(input: string | undefined | null): string | null {
  if (!input || input === "0x" || input.length < 10) return null;
  return `0x${input.slice(2, 10).toLowerCase()}`;
}

export async function getLatestBlockNumber(): Promise<number | null> {
  const urls = candidateRpcUrls();
  for (const url of urls) {
    const client = createPublicClient({ chain: arcTestnet, transport: http(url) });
    const n = await withBackoff<bigint | null>(3, () => client.getBlockNumber() as Promise<bigint>, isTransientRpcError);
    if (n !== null && n !== undefined) return Number(n);
  }
  return null;
}

/**
 * Read-only contract call across every candidate RPC until one answers.
 * Returns null when the read fails on all of them.
 */
export async function readContractReliable<
  TAbi extends Abi,
  TFunctionName extends Extract<TAbi[number], { type: "function" }>["name"]
>(
  params: {
    address: string;
    abi: TAbi;
    functionName: TFunctionName;
    args: readonly unknown[];
    blockNumber?: bigint;
  }
): Promise<any | null> {
  const urls = candidateRpcUrls();
  for (const url of urls) {
    const client = createPublicClient({ chain: arcTestnet, transport: http(url) });
    const result = await withBackoff<any | null>(
      3,
      async () => {
        try {
          return await client.readContract({
            address: params.address as Hash,
            abi: params.abi as Abi,
            functionName: params.functionName as string as AbiFunction["name"],
            args: params.args,
            ...(params.blockNumber !== undefined ? { blockNumber: params.blockNumber } : {}),
          });
        } catch (e) {
          // revert on read (e.g. non-existent slot) — not transient, stop trying THIS rpc
          return null;
        }
      },
      isTransientRpcError
    );
    if (result !== null && result !== undefined) return result;
  }
  return null;
}
