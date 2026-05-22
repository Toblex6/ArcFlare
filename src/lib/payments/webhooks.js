import express from "express";
import { verifyGatewayWebhook } from "@circle-fin/gateway-sdk"; // For Nanopayments validation
import { relayerMintUsdcOnArc } from "./cctp.js"; // Import your Step 2 script
import dotenv from "dotenv";
dotenv.config();

const webhookRouter = express.Router();

// Parse raw text bodies to accurately check cryptographic signatures
webhookRouter.use(express.text({ type: "application/json" }));

/**
 * 1. WEBHOOK FOR NANOPAYMENTS: Batched Settlement Updates
 */
webhookRouter.post("/api/v1/webhooks/nanopayments", async (req, res) => {
  const signature = req.headers["circle-signature"];
  const payload = req.body;

  // Security Verification: Ensure this actually came from Circle and isn't a hacker fake
  const isValid = verifyGatewayWebhook({
    payload,
    signature,
    secret: process.env.CIRCLE_WEBHOOK_SECRET // Set this from your Circle Developer Dashboard
  });

  if (!isValid) {
    return res.status(401).send("Unauthorized Webhook Signature");
  }

  const event = JSON.parse(payload);

  // When Circle successfully settles a massive batch of sub-cent transactions on-chain
  if (event.type === "gateway.settlement.completed") {
    const { merchantAddress, settledAmount, paymentCount, txHash } = event.data;

    console.log(`Successfully settled ${settledAmount} USDC across ${paymentCount} micro-payments.`);
    
    // TODO: Write a database query to update your merchant balance ledger
    // await db.merchants.incrementBalance(merchantAddress, settledAmount);
  }

  res.status(200).send("OK");
});

/**
 * 2. WEBHOOK FOR CCTP V2: Cross-Chain Transfer Completion
 * Fires when a user successfully burns tokens on Ethereum, triggering the Arc claim.
 */
webhookRouter.post("/api/v1/webhooks/cctp", async (req, res) => {
  const event = JSON.parse(req.body);

  // If Circle's cross-chain relayer architecture logs a successful native burn event
  if (event.type === "cctp.usdc.burned") {
    const { txHash, destinationChain } = event.data;

    // Check if the burn destination was meant for the Arc Network
    if (destinationChain === "arc") {
      try {
        console.log(`Detected burn event ${txHash}. Initiating mint relay on Arc...`);
        
        // Execute the cross-chain claim engine we built earlier!
        const result = await relayerMintUsdcOnArc(txHash);
        
        console.log(`Mint complete on Arc! Tx Hash: ${result}`);
      } catch (error) {
        console.error("Failed to automatically claim cross-chain native mint:", error);
        return res.status(500).send("Relay Error");
      }
    }
  }

  res.status(200).send("OK");
});

export default webhookRouter;