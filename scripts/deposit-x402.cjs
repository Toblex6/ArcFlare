// scripts/deposit-x402.cjs
const { GatewayClient } = require("@circle-fin/x402-batching/client");

async function main() {
  console.log("🟢 Script started");

  // Replace with your private key (the one that owns the USDC)
  const PRIVATE_KEY = "0xfdaedba1c86f313f87e0bffccd8ffb4d776df837e718720503b62b86b48f45f8";
  console.log("🔑 Private key loaded (owner of USDC)");

  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: PRIVATE_KEY,
  });
  console.log("✅ GatewayClient created");

  // The amount to deposit (in USDC, as a string)
  const amount = "1"; // 1 USDC

  console.log(`📤 Depositing ${amount} USDC into Gateway...`);

  try {
    // The deposit method returns a transaction hash
    const txHash = await client.deposit(amount);
    console.log("✅ Deposit successful!");
    console.log("📝 Transaction hash:", txHash);

    // Optional: wait for finality and check balance
    console.log("⏳ Waiting 5 seconds for finality...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check balance after deposit
    const address = client.getAddress(); // get the address from the private key
    const balanceResponse = await client.gateway.getBalance(address);
    console.log(`💰 Gateway balance for ${address}:`);
    console.log(`   Available: ${balanceResponse.available / 1e6} USDC`);
    console.log(`   Total: ${balanceResponse.total / 1e6} USDC`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.response?.data) {
      console.error("Gateway response:", JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();