import axios from "axios";
import { withWallet } from "@walletconnect/cli-sdk";
import { ethers } from "ethers";

const TARGET_API = "http://localhost:3000/api/v1/agent-service";

async function runAutonomousLifecycle() {
  console.log("🤖 [Agent] Attempting to access premium data pipeline...");

  try {
    // FIRST ATTEMPT: Try to grab the asset for free
    const response = await axios.post(TARGET_API, { query: "fetch_market_signals" });
    console.log("Response:", response.data);
    
  } catch (error: any) {
    // Check if the server caught us and threw an intentional 402 roadblock
    if (error.response && error.response.status === 402) {
      const roadblockParams = error.response.data;
      console.log(`🛑 [Agent] Hit HTTP 402 Roadblock! Cost detected: ${roadblockParams.amount_due} ${roadblockParams.currency}`);
      
      console.log("✍️ [Agent] Spinning up WalletConnect session to execute secure on-chain payment...");

      // Replaces the old random text simulation with an actual Arc Testnet payment contract action!
      await withWallet(
        {
          projectId: "your_walletconnect_project_id", // From cloud.walletconnect.com
          metadata: {
            name: "ArcFlare Autonomous Buyer",
            description: "AgentFi Settlement Engine",
            url: "https://arcflare-gateway.onrender.com"
          }
        },
        async (wallet, { accounts }) => {
          const agentWalletAddress = accounts[0].split(":").pop();
          console.log(`📡 Paired Agent Address: ${agentWalletAddress}`);

          // Request an actual cryptographic transaction broadcast from the paired wallet
          const realTxHash = await wallet.request({
            chainId: "eip155:49111", // Arc Testnet L1 Chain ID
            request: {
              method: "eth_sendTransaction",
              params: [{
                from: agentWalletAddress,
                to: roadblockParams.payment_gateway_address, // Dynamic extraction straight from the 402 data!
                value: ethers.utils.parseUnits(roadblockParams.amount_due.toString(), 6).toHexString() // Parse 0.01 USDC
              }]
            }
          });

          console.log(`⛽ [Agent] Real transaction broadcasted to Arc L1! Tx Hash: ${realTxHash}`);

          console.log("🔄 [Agent] Re-submitting data request with cryptographic payment proof in headers...");
          
          // SECOND ATTEMPT: Try again, sending the valid realTxHash in the headers
          const secondAttempt = await axios.post(
            TARGET_API, 
            { query: "fetch_market_signals" },
            { headers: { "x-arcflare-tx-hash": realTxHash } }
          );

          console.log("✅ [Agent] Resource unlocked successfully!");
          console.log("📦 Ingested Payload Data:", secondAttempt.data.data);
        }
      );
    } else {
      console.error("Fatal Agent Loop Interruption:", error.message);
    }
  }
}

runAutonomousLifecycle();