import axios from "axios";

// Points to your local server running alongside your active Cloudflare tunnel
const TARGET_URL = "https://arcflare-gateway.onrender.com/api/agent-data";

async function simulateAgent() {
  console.log("🤖 [Agent]: Attempting to query protected data stream...");

  try {
    // 1. First attempt: Call the endpoint without any payment headers
    const initialResponse = await axios.get(TARGET_URL);
    console.log("Initial response:", initialResponse.data);
  } catch (error: any) {
    // Check if the server responded with an actual HTTP error code
    if (error.response) {
      if (error.response.status === 402) {
        const paymentChallenge = error.response.data;
        console.log(`\n⚠️ [Paywall Hit]: HTTP 402 Payment Required!`);
        console.log(`💸 [Cost]: ${paymentChallenge.amount} ${paymentChallenge.currency} on ${paymentChallenge.settlementChain}`);
        
        // 2. Autonomous Decision: Simulate signing a transaction or generating a reference proof
        console.log("⚙️ [Agent]: Generating payment authorization and signing payload...");
        const mockTxReference = "arc_tx_" + Math.random().toString(36).substring(2, 15);
        
        console.log(`🚀 [Agent]: Retrying request with reference: ${mockTxReference}\n`);

        // 3. Second attempt: Re-query the endpoint with the mandatory headers attached
        try {
          const paidResponse = await axios.get(TARGET_URL, {
            headers: {
              "x-payment-reference": mockTxReference,
              "x-agent-email": "siggy-bot@arcflare.xyz",
              "x-merchant-name": "ArcFlare Main Engine"
            }
          });

          console.log("✅ [Success] Data unlocked by Agent:");
          console.dir(paidResponse.data, { depth: null });
        } catch (retryError: any) {
          console.error("❌ Retry failed:", retryError.response?.data || retryError.message);
        }
      } else {
        console.error(`❌ Server Responded with Status: ${error.response.status}`);
        console.error("Data:", error.response.data);
      }
    } else {
      // The server wasn't reached at all (e.g., Network Error / Server Offline)
      console.error("\n❌ Connection Details:");
      console.error(`   Message: ${error.message}`);
      console.error(`   Code:    ${error.code || "N/A"}`);
      console.error("💡 Tip: Make sure 'npm run dev' is running in another terminal window!");
    }
  }
}

simulateAgent();