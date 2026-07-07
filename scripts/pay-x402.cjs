// scripts/pay-x402.cjs
require("dotenv").config({ path: ".env" });
const { GatewayClient } = require("@circle-fin/x402-batching/client");

async function main() {
  const PRIVATE_KEY = process.env.EOA_PRIVATE_KEY;
  const BUYER_ADDRESS = process.env.BUYER_ADDRESS;

  if (!PRIVATE_KEY) {
    console.error("❌ EOA_PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  console.log(`🔑 Buyer wallet: ${BUYER_ADDRESS}`);

  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: PRIVATE_KEY,
  });

  // Check Gateway balance first
  const balances = await client.getBalances();
  const available = balances?.gateway?.formattedAvailable ?? "0";
  console.log(`💰 Gateway balance: ${available} USDC`);

  if (parseFloat(available) <= 0) {
    console.error("❌ No Gateway balance. Run:");
    console.error(`   circle gateway deposit --address ${BUYER_ADDRESS} --chain ARC-TESTNET --amount 10 --method direct`);
    process.exit(1);
  }

  const url = "https://arcflare-gateway.onrender.com/api/nano/pay/agent-lookup?scaAddress=0x7a8214dad7630a7a39054e0121acdbc7a65821c9";
  console.log("📡 Paying...");

  const response = await client.pay(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  console.log("✅ Payment successful!");
  console.log("Transaction:", response.transaction);
  console.log("Data:", JSON.stringify(response.data, null, 2));
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.cause) console.error("Cause:", err.cause);
});