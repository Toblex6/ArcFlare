// pay-x402.cjs
const { GatewayClient } = require("@circle-fin/x402-batching/client");

async function main() {
  console.log("🟢 Script started");

  const PRIVATE_KEY = "0x63a973bd7da204e2e604f2ece36227165b2bae9fc4217f9b46816141d4d8cbfe";
  console.log("🔑 Private key loaded");

  const client = new GatewayClient({
    chain: "ARC-TESTNET",
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
    });

    console.log("✅ Payment successful!");
    console.log("Response data:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message && error.message.includes("INSUFFICIENT_TOKEN")) {
      console.error("\n💡 Fund your wallet at https://faucet.circle.com");
      console.error("   Address: 0x9dc466206cF2D01f096C0aEd17A053c472a7cB08");
    }
  }
}

main();