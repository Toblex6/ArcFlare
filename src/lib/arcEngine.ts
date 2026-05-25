import { ethers } from "ethers";

// Standard ERC-20 transfer event ABI snippet 
const ERC20_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

/**
 * Validates an on-chain transaction hash against Circle Arc L1 RPC node profiles
 */
export async function verifyArcTestnetTx(
  txHash: string, 
  expectedAmount: number,
  merchantAddress: string
): Promise<boolean> {
  // Check hash shape sanity
  if (!txHash.startsWith("0x") || txHash.length !== 66) {
    console.error("❌ [Arc Engine]: Malformed transaction hash footprint.");
    return false;
  }

  try {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC);
    
    console.log(`📡 [Arc Engine]: Indexing chain state for transaction hash: ${txHash}`);
    const receipt = await provider.getTransactionReceipt(txHash);

    // Ensure block transaction executed successfully
    if (!receipt || receipt.status !== 1) {
      console.log("❌ [Arc Engine]: Transaction dropped, failed, or invalid.");
      return false;
    }

    const iface = new ethers.Interface(ERC20_TRANSFER_ABI);
    const targetToken = process.env.ARC_USDC_ADDRESS?.toLowerCase();

    // Iterate through execution event logs
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== targetToken) continue;

      try {
        const parsedLog = iface.parseLog({ topics: [...log.topics], data: log.data });
        
        if (parsedLog && parsedLog.name === "Transfer") {
          const { to, value } = parsedLog.args;
          
          // Native USDC on Arc uses 6 decimal points for stable transfers
          const actualAmount = parseFloat(ethers.formatUnits(value, 6));
          
          const destinationMatches = to.toLowerCase() === merchantAddress.toLowerCase();
          const amountMatches = actualAmount >= expectedAmount;

          if (destinationMatches && amountMatches) {
            console.log(`✅ [Arc Engine]: Payment verified natively! Received ${actualAmount} USDC.`);
            return true;
          }
        }
      } catch (logError) {
        continue; // Skip unrecognized structural footprint signatures
      }
    }

    console.log("❌ [Arc Engine]: Transfer parameter checks failed.");
    return false;

  } catch (error) {
    console.error("❌ [Arc Engine]: RPC Node routing error:", error);
    return false;
  }
}