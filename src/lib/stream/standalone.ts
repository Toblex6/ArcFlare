// Shared standalone stream helpers. No ERC-8183 job dependency.
import { Interface } from "ethers";
import { getReceiptReliable } from "@/lib/wallet/chainClient";
import { ARC_FLARE_STREAM_ABI, readStreamOnChain } from "@/lib/contracts/streamContract";

const streamInterface = new Interface(ARC_FLARE_STREAM_ABI as unknown as string[]);

export function parseStreamAmount(value: unknown): bigint {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error("totalBudget must be a positive USDC amount with at most 6 decimals");
  const [whole, fraction = ""] = raw.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n || amount > 10_000_000n * 1_000_000n) throw new Error("totalBudget is outside the supported range");
  return amount;
}

export function formatStreamAmount(value: bigint): string {
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

export async function verifyStreamTransaction(params: { txHash: string; from: string; contractAddress: string }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) return { ok: false as const, error: "Invalid transaction hash." };
  const receipt = await getReceiptReliable(params.txHash);
  if (!receipt) return { ok: false as const, error: "Transaction is not mined yet." };
  if (receipt.status !== "success") return { ok: false as const, error: "Transaction reverted." };
  if (receipt.from.toLowerCase() !== params.from.toLowerCase()) return { ok: false as const, error: "Transaction sender is not the stream poster." };
  if (receipt.to?.toLowerCase() !== params.contractAddress.toLowerCase()) return { ok: false as const, error: "Transaction was not sent to ArcFlareStream." };
  return { ok: true as const, receipt };
}

export function streamOpenedFromReceipt(receipt: any, contractAddress: string): { streamId: bigint; poster: string; worker: string; token: string; totalBudget: bigint; trancheCount: bigint } | null {
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const parsed = streamInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "StreamOpened") return {
        streamId: BigInt(parsed.args.streamId), poster: String(parsed.args.poster), worker: String(parsed.args.worker),
        token: String(parsed.args.token), totalBudget: BigInt(parsed.args.totalBudget), trancheCount: BigInt(parsed.args.trancheCount),
      };
    } catch {}
  }
  return null;
}

export async function exactStreamState(params: { streamId: bigint; poster: string; worker: string; token: string; totalBudget: bigint; trancheCount: number }) {
  const state = await readStreamOnChain(params.streamId);
  return state.poster.toLowerCase() === params.poster.toLowerCase()
    && state.worker.toLowerCase() === params.worker.toLowerCase()
    && state.token.toLowerCase() === params.token.toLowerCase()
    && state.totalBudget === params.totalBudget
    && state.trancheCount === BigInt(params.trancheCount) ? state : null;
}
