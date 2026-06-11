import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// Singleton Circle client instance
let circleClientInstance: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

export function getCircleClient() {
  if (!circleClientInstance) {
    if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
      throw new Error("Missing Circle credentials: CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in environment");
    }

    circleClientInstance = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
  }
  return circleClientInstance;
}

export async function waitForTransaction(
  txId: string,
  label: string,
  timeoutSeconds: number = 120
): Promise<string> {
  const circleClient = getCircleClient();
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  console.log(`  ⏳ Waiting for ${label}...`);

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const { data } = await circleClient.getTransaction({ id: txId });
      const state = data?.transaction?.state;

      if (state === "COMPLETE") {
        const txHash = data.transaction.txHash;
        if (!txHash) {
          throw new Error(`${label} completed but no txHash returned`);
        }
        console.log(`  ✅ ${label} complete: ${txHash}`);
        return txHash;
      }

      if (state === "FAILED") {
        throw new Error(`${label} failed onchain`);
      }

      process.stdout.write(".");
    } catch (error) {
      console.error(`Error checking transaction ${txId}:`, error);
      throw error;
    }
  }

  throw new Error(`${label} timed out after ${timeoutSeconds}s`);
}

export async function createContractTransaction(
  walletAddress: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: any[],
  label: string
): Promise<string> {
  const circleClient = getCircleClient();

  const stringParams = abiParameters.map((p) => String(p));

  console.log(`  📝 Creating ${label} transaction...`);

  const tx = await circleClient.createContractExecutionTransaction({
    walletAddress,
    blockchain: "ARC-TESTNET",
    contractAddress,
    abiFunctionSignature,
    abiParameters: stringParams,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const txId = tx.data?.id;
  if (!txId) {
    throw new Error(`Failed to create ${label} transaction: no transaction ID returned`);
  }

  console.log(`  📋 Transaction created: ${txId}`);

  return waitForTransaction(txId, label);
}

export async function getWalletBalance(walletId: string): Promise<string> {
  const circleClient = getCircleClient();

  const balances = await circleClient.getWalletTokenBalance({ id: walletId });
  const usdc = balances.data?.tokenBalances?.find(
    (b) => b.token?.symbol === "USDC"
  );

  return usdc?.amount ?? "0";
}

export async function getWallet(walletId: string) {
  const circleClient = getCircleClient();
  const response = await circleClient.getWallet({ id: walletId });
  return response.data?.wallet;
}

export async function createWallets(name: string, count: number = 2) {
  const circleClient = getCircleClient();

  console.log(`  🔧 Creating wallet set: ${name}`);

  const walletSet = await circleClient.createWalletSet({ name });

  const walletSetId = walletSet.data?.walletSet?.id;
  if (!walletSetId) {
    throw new Error("Failed to create wallet set");
  }

  console.log(`  📦 Wallet set created: ${walletSetId}`);

  const walletsResponse = await circleClient.createWallets({
    blockchains: ["ARC-TESTNET"],
    count,
    walletSetId,
    accountType: "SCA",
  });

  const wallets = walletsResponse.data?.wallets ?? [];
  console.log(`  👛 Created ${wallets.length} wallet(s)`);

  wallets.forEach((wallet, i) => {
    console.log(`     ${i + 1}. ${wallet.address} (${wallet.id})`);
  });

  return {
    walletSetId,
    wallets: wallets.map((w) => ({
      id: w.id,
      address: w.address,
      state: w.state,
    })),
  };
}