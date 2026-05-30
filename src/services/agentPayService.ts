// src/services/agentPayService.ts
import { withWallet } from "@walletconnect/cli-sdk";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

// Explicitly load configuration variables from environment files
dotenv.config();

// Enforce environment validation rules at startup to satisfy Next.js compiler scanning
const adminKey = process.env.ARC_ADMIN_PRIVATE_KEY;
if (!adminKey) {
  console.warn("⚠️ ARC_ADMIN_PRIVATE_KEY is not defined in your active environment configurations.");
}

interface AgentPaymentIntent {
  merchantAddress: string;
  amountInUSDC: string;
  paymentReference: string;
}

/**
 * Executes an autonomous transaction on the Arc Testnet using a WalletConnect paired session
 */
export async function executeAgentPayment(intent: AgentPaymentIntent): Promise<void> {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID;
  const chainId = process.env.ARC_CHAIN_ID || "eip155:49111";

  if (!projectId) {
    throw new Error("Missing WALLETCONNECT_PROJECT_ID in environment variables.");
  }

  // ✅ FIXED: Ethers v6 flattens parseUnits directly on the base package namespace and outputs a BigInt
  const parsedBigIntAmount = ethers.parseUnits(intent.amountInUSDC, 6);
  const parsedAmountHex = ethers.toBeHex(parsedBigIntAmount);

  console.log(`🤖 AI Agent: Initiating transaction for reference ${intent.paymentReference}...`);

  try {
    // withWallet sets up the high-level session helper loop (connect -> use -> cleanup)
    await withWallet(
      {
        projectId: projectId,
        metadata: {
          name: "ArcFlare AI Agent Node",
          description: "Autonomous Agentic Finance Layer for Arc Network",
          url: "https://arcflare-gateway.onrender.com",
          icons: ["https://arcflare-gateway.onrender.com/favicon.ico"],
        },
      },
      async (wallet, { accounts }) => {
        // Extract the raw wallet public address from the CAIP-10 formatted string
        const agentAssociatedAddress = accounts[0]?.split(":").pop();
        
        if (!agentAssociatedAddress) {
          console.error("🔴 Failed to extract a valid public wallet account address from session.");
          return;
        }
        
        console.log(`📡 Linked Session Account Verified: ${agentAssociatedAddress}`);

        try {
          console.log(`💸 Pushing programmatic payment prompt to authorized wallet...`);
          
          // Broadcast the transaction request over the WalletConnect channel natively
          const txHash = await wallet.request({
            chainId: chainId,
            request: {
              method: "eth_sendTransaction",
              params: [
                {
                  from: agentAssociatedAddress,
                  to: intent.merchantAddress,
                  data: "0x", 
                  value: parsedAmountHex, 
                },
              ],
            },
          });

          console.log(`🟢 ArcFlare Agent Payment Dispatched Successfully!`);
          console.log(`🔗 Arc Testnet Tx Hash: ${txHash}`);

          // ✅ FIXED: Force-cast txHash as string to pass safety rules for unknown object structures
          await triggerArcFlareVerification(intent.paymentReference, txHash as string);

        } catch (error) {
          console.error("🔴 Agent transaction failed or was rejected by supervisor:", error);
        }
      }
    );
  } catch (outerError) {
    console.error("🔴 Critical failure initializing the WalletConnect agent workflow loop:", outerError);
  }
}

/**
 * Pings your existing ArcFlare validation endpoint to shift status from PENDING to SUCCESS
 */
async function triggerArcFlareVerification(reference: string, hash: string): Promise<void> {
  try {
    const response = await fetch("https://arcflare-gateway.onrender.com/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference, txHash: hash }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP gateway responded with status code ${response.status}`);
    }

    const result = await response.json();
    console.log(`🔄 Verification Ledger Updated:`, result.status || "SUCCESS");
  } catch (err) {
    console.error("⚠️ Failed to automatically alert internal ArcFlare verification engine:", err);
  }
}