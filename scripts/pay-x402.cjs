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

  // Check balance first
  const balances = await client.getBalances();
  console.log(`💰 Gateway balance: ${balances.gateway.formattedAvailable} USDC`);
  if (parseFloat(balances.gateway.formattedAvailable) <= 0) {
    console.error("❌ No Gateway balance. Run: node scripts/deposit-x402.cjs");
    process.exit(1);
  }

  console.log("📡 Calling agent brain...");

  const response = await client.pay(
    "https://flarehq.xyz/api/agent/brain",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Pay 0.1 USDC to 0x954ebd124aedf03b784fcf2cb067de98f04bfa3a as a test A2A payment",
        sessionId: "a2a-test-1",
      }),
      //validity: { maxSeconds: 604800 }, // matches seller's exact maxTimeoutSeconds
    }
  );

  console.log("✅ Payment successful!");
  console.log("Transaction:", response.transaction);
  console.log("Data:", JSON.stringify(response.data, null, 2));
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.cause) console.error("Cause:", err.cause);
});
