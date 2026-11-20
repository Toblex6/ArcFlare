import { getNetworkConfig } from "@/lib/config/network";
import { getCircleClient } from "@/lib/circle/client";
import { resolveExactJobWallet, externalJobTransaction } from "@/lib/jobs/flarehqEscrowActions";

export { resolveExactJobWallet as resolveExactStreamWallet, externalJobTransaction as externalStreamTransaction };

export async function executeCircleStreamCall(params: { wallet: Awaited<ReturnType<typeof resolveExactJobWallet>>; contractAddress: string; signature: string; args: string[]; label: string }) {
  if (!params.wallet || params.wallet.mode !== "CIRCLE" || !params.wallet.circleWalletId) throw new Error("The exact stream poster wallet is not Circle-managed.");
  const client = getCircleClient();
  const tx = await client.createContractExecutionTransaction({
    walletAddress: params.wallet.address,
    blockchain: getNetworkConfig().circleBlockchain as any,
    contractAddress: params.contractAddress,
    abiFunctionSignature: params.signature,
    abiParameters: params.args,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!tx.data?.id) throw new Error(`${params.label} returned no transaction id.`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: tx.data.id });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) return data.transaction.txHash;
    if (data?.transaction?.state === "FAILED") throw new Error(`${params.label} failed on-chain.`);
  }
  throw new Error(`${params.label} timed out.`);
}
