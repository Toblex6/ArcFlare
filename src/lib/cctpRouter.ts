import { ethers } from "ethers";

// Circle's official CCTP Attestation API endpoint rules
const CIRCLE_ATTESTATION_API = "https://iris-api-sandbox.circle.com/v1/attestations";

// Minimal ABI required to fetch the MessageSent log from the source chain
const SOURCE_MESSAGE_TRANSMITTER_ABI = [
  "event MessageSent(bytes message)"
];

/**
 * Core Cross-Chain Router Module for ArcFlare
 */
export class CCTPRouter {
  /**
   * Extracts the raw message bytes from a source chain burn transaction log array.
   */
  static extractMessageBytes(receipt: ethers.TransactionReceipt): string | null {
    const iface = new ethers.Interface(SOURCE_MESSAGE_TRANSMITTER_ABI);
    
    for (const log of receipt.logs) {
      try {
        const parsedLog = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsedLog && parsedLog.name === "MessageSent") {
          return parsedLog.args.message;
        }
      } catch {
        continue; // Log did not match CCTP signature parameters
      }
    }
    return null;
  }

  /**
   * Polls Circle's Iris API to fetch the cryptographic validation signature (Attestation)
   * required to mint the stablecoins on the destination chain.
   */
  static async fetchCircleAttestation(messageHash: string, maxRetries = 10): Promise<string | null> {
    console.log(`📡 [CCTP Router]: Querying Circle Attestation API for message hash: ${messageHash}`);
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${CIRCLE_ATTESTATION_API}/${messageHash}`);
        const json = await response.json();

        if (json.status === "complete" && json.attestation) {
          console.log("✅ [CCTP Router]: Circle Attestation signature successfully retrieved!");
          return json.attestation;
        }

        console.log(`⏳ [CCTP Router]: Attestation processing... Retrying in 5s (Attempt ${i + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      } catch (error) {
        console.error("❌ [CCTP Router]: Error contacting Circle infrastructure:", error);
      }
    }
    return null;
  }
}