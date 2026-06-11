import { getCircleClient, createWallets } from "../src/lib/circle/client";

async function main() {
  console.log("Creating ERC-8183 test wallets...");
  
  const { walletSetId, wallets } = await createWallets("ERC8183 Test Wallets", 2);
  
  console.log("\n✅ Wallets created successfully!");
  console.log("Wallet Set ID:", walletSetId);
  console.log("\nClient Wallet (funds escrow & completes):", wallets[0].address);
  console.log("Client Wallet ID:", wallets[0].id);
  console.log("\nProvider Wallet (sets budget & submits):", wallets[1].address);
  console.log("Provider Wallet ID:", wallets[1].id);
}

main().catch(console.error);