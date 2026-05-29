import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

async function main() {
  console.log("🚀 Initializing ArcFlare Autonomous Test Agent (Programmatic Signer Mode)...");
  console.log(`📡 Targeting Endpoint Gateway: ${BASE_URL}`);

  const testKey = process.env.TEST_AGENT_PRIVATE_KEY || "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const account = privateKeyToAccount(testKey as `0x${string}`);
  
  const client = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  console.log(`🤖 Agent Payer Entity Verified: ${client.account.address}`);

  try {
    console.log("\n📦 Pipeline Step 1: Testing Agent Provisioning Flow...");
    const deployResponse = await axios.post(`${BASE_URL}/api/agent/deploy`, {
      agentOwner: client.account.address,
      metadata: {
        name: "ArcFlare Autonomous Buyer",
        description: "AgentFi Settlement Engine"
      }
    });
    console.log("✅ Provisioning API Response:", deployResponse.data);

    console.log("\n💳 Pipeline Step 2: Testing Machine-to-Machine Payment Trigger...");
    const paymentResponse = await axios.post(`${BASE_URL}/api/payments/initialize`, {
      amount: "15.00",
      currency: "USDC",
      recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      payerEntity: client.account.address
    });
    
    console.log("✅ Payment Settlement Initialized Successfully!");
    console.log(`🔗 Tracking Reference ID: ${paymentResponse.data.reference || "Generated Onchain"}`);

  } catch (error: any) {
    console.error("\n❌ Autonomous Pipeline Test Execution Encountered an Error:");
    if (error.response) {
      console.error(`Status Code: ${error.response.status}`);
      console.error("Payload Data:", error.response.data);
    } else {
      console.error("System Error Message:", error.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });