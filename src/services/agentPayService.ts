import { withWallet } from "@walletconnect/cli-sdk";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

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

  // Convert human-readable USDC to standard 6-decimal format
  const parsedAmount = ethers.utils.parseUnits(intent.amountInUSDC, 6).toHexString();

  console.log(`🤖 AI Agent: Initiating transaction for reference ${intent.paymentReference}...`);

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
      const agentAssociatedAddress = accounts[0].split(":").pop();
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
                data: "0x", // If interacting with an absolute stablecoin contract, pass ERC20 transfer abi hex here
                value: parsedAmount, 
              },
            ],
          },
        });

        console.log(`🟢 ArcFlare Agent Payment Dispatched Successfully!`);
        console.log(`🔗 Arc Testnet Tx Hash: ${txHash}`);

        // Automatically hand off the txHash to your existing verification endpoint
        await triggerArcFlareVerification(intent.paymentReference, txHash);

      } catch (error) {
        console.error("🔴 Agent transaction failed or was rejected by supervisor:", error);
      }
    }
  );
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
    const result = await response.json();
    console.log(`🔄 Verification Ledger Updated:`, result.status);
  } catch (err) {
    console.error("⚠️ Failed to automatically alert internal ArcFlare verification engine:", err);
  }
}