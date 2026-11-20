// Server-only FlareHQ Job → FlareHQEscrow execution helpers.
//
// Wallet identity is always resolved for the exact job party address. There
// is no default payer and no shared-wallet fallback. Circle-managed wallets
// execute through Circle; external wallets receive an unsigned transaction
// and submit the mined hash for receipt + state verification.

import { type Hash } from "viem";
import { prisma } from "@/lib/prisma";
import { getCircleClient } from "@/lib/circle/client";
import { getNetworkConfig } from "@/lib/config/network";
import { getReceiptReliable, readContractReliable } from "@/lib/wallet/chainClient";
import { escrowAbi } from "@/lib/wallet/flarehqContracts";

export interface ExactJobWallet {
  address: string;
  mode: "CIRCLE" | "EXTERNAL";
  circleWalletId: string | null;
  source: "merchant" | "consumer" | "agent";
}

export async function resolveExactJobWallet(address: string): Promise<ExactJobWallet | null> {
  const insensitive = { equals: address, mode: "insensitive" as const };
  const [merchant, consumer, agent] = await Promise.all([
    (prisma as any).merchant.findFirst({ where: { walletAddress: insensitive }, select: { walletAddress: true, walletProvider: true, circleWalletId: true } }),
    (prisma as any).consumerAccount.findFirst({ where: { walletAddress: insensitive }, select: { walletAddress: true, walletType: true, circleWalletId: true } }),
    (prisma as any).agentRegistry.findFirst({ where: { scaAddress: insensitive }, select: { scaAddress: true, circleWalletId: true } }),
  ]);
  if (agent) return { address: agent.scaAddress, mode: agent.circleWalletId ? "CIRCLE" : "EXTERNAL", circleWalletId: agent.circleWalletId ?? null, source: "agent" };
  if (consumer) return { address: consumer.walletAddress, mode: consumer.walletType === "CIRCLE" && consumer.circleWalletId ? "CIRCLE" : "EXTERNAL", circleWalletId: consumer.circleWalletId ?? null, source: "consumer" };
  if (merchant) return { address: merchant.walletAddress, mode: merchant.walletProvider === "CIRCLE" && merchant.circleWalletId ? "CIRCLE" : "EXTERNAL", circleWalletId: merchant.circleWalletId ?? null, source: "merchant" };
  return null;
}

export async function executeCircleJobEscrowCall(params: {
  wallet: ExactJobWallet;
  contractAddress: string;
  signature: string;
  args: Array<string | boolean>;
  label: string;
}): Promise<string> {
  if (params.wallet.mode !== "CIRCLE" || !params.wallet.circleWalletId) {
    throw new Error("The exact job party wallet is not Circle-managed.");
  }
  const client = getCircleClient();
  const tx = await client.createContractExecutionTransaction({
    // Exact party address, not a default wallet id/address fallback.
    walletAddress: params.wallet.address,
    blockchain: getNetworkConfig().circleBlockchain as any,
    contractAddress: params.contractAddress,
    abiFunctionSignature: params.signature,
    abiParameters: params.args,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!tx.data?.id) throw new Error(`${params.label} returned no transaction id.`);
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const { data } = await client.getTransaction({ id: tx.data.id });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) return data.transaction.txHash;
    if (data?.transaction?.state === "FAILED") {
      throw new Error(`${params.label} failed on-chain.${data.transaction.errorReason ? ` Reason: ${data.transaction.errorReason}` : ""}`);
    }
  }
  throw new Error(`${params.label} timed out.`);
}

export function externalJobTransaction(params: {
  description: string;
  from: string;
  to: string;
  signature: string;
  args: Array<string | boolean>;
}) {
  return {
    description: params.description,
    chainId: getNetworkConfig().chainId,
    from: params.from,
    to: params.to,
    abiFunctionSignature: params.signature,
    args: params.args,
    value: "0",
  };
}

/** Receipt binds sender + escrow contract. State binds the lifecycle effect. */
export async function verifyExternalJobEscrowCall(params: {
  txHash: string;
  from: string;
  contractAddress: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) return { ok: false, error: "Invalid transaction hash." };
  const receipt = await getReceiptReliable(params.txHash);
  if (!receipt) return { ok: false, error: "Transaction is not mined yet." };
  if (receipt.status !== "success") return { ok: false, error: "Transaction reverted on-chain." };
  if (receipt.from.toLowerCase() !== params.from.toLowerCase()) return { ok: false, error: "Transaction sender is not the job party wallet." };
  if (receipt.to?.toLowerCase() !== params.contractAddress.toLowerCase()) return { ok: false, error: "Transaction was not sent to FlareHQEscrow." };
  return { ok: true };
}

export async function readJobEscrowState(contractAddress: string, escrowId: string): Promise<any | null> {
  return readContractReliable({
    address: contractAddress as `0x${string}`,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [escrowId as Hash],
  });
}

export function escrowStateField(state: any, name: "depositorConfirmed" | "beneficiaryConfirmed", tupleIndex: 5 | 6): boolean {
  return Boolean(typeof state?.[name] === "boolean" ? state[name] : state?.[tupleIndex]);
}
