// scripts/check-balance.ts
import { GatewayClient } from "@circle-fin/x402-batching/client";

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: npx tsx scripts/check-balance.ts <address>");
    process.exit(1);
  }

  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001", // dummy
  });

  const balance = await client.gateway.getBalance(address as `0x${string}`);
  console.log(`💰 Gateway balance for ${address}:`);
  console.log(`   Available: ${balance.available / 1e6} USDC`);
  console.log(`   Total: ${balance.total / 1e6} USDC`);
}

main().catch(console.error);