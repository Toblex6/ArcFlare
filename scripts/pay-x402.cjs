// scripts/pay-x402.cjs
const { GatewayClient } = require("@circle-fin/x402-batching/client");

async function main() {
  console.log("🟢 Script started");

  // ✅ Use the private key for 0x902C... (has Gateway balance)
  const PRIVATE_KEY = "0xfdaedba1c86f313f87e0bffccd8ffb4d776df837e718720503b62b86b48f45f8";
  console.log("🔑 Private key loaded (address: 0x902C565bE31c146a79350387C1f77d6896814B58)");

  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: PRIVATE_KEY,
  });
  console.log("✅ GatewayClient created");

  const url =
    "https://arcflare-gateway.onrender.com/api/nano/pay/agent-lookup?scaAddress=0x7a8214dad7630a7a39054e0121acdbc7a65821c9";
  console.log("📡 Calling pay...");

  try {
    const response = await client.pay(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      validity: {
        maxSeconds: 604800,   // ✅ match seller's maxTimeoutSeconds
      },
    });

    console.log("✅ Payment successful!");
    console.log("Response data:", JSON.stringify(response.data, null, 2));
    console.log("Transaction hash:", response.transaction);
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.response?.data) {
      console.error("Gateway response:", JSON.stringify(error.response.data, null, 2));
    }
    if (error.message && error.message.includes("INSUFFICIENT_TOKEN")) {
      console.error("\n💡 Fund your wallet at https://faucet.circle.com");
      console.error("   Address: 0x902C565bE31c146a79350387C1f77d6896814B58");
    }
  }
}

main();