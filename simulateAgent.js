/**
 * ArcFlare AI Agent Simulation Loop - Production Ready & Flexible
 */
async function runAgentTask() {
  // 👇 CHANGE THIS line to true for local testing, or false to test your live Render link!
  const IS_LOCAL_TESTING = true; 

  const BASE_URL = IS_LOCAL_TESTING 
    ? "http://localhost:3000" 
    : "https://arcflare-gateway.onrender.com";

  const PROTECTED_RESOURCE = `${BASE_URL}/api/protected-service`;
  const INITIALIZE_API = `${BASE_URL}/api/payments/initialize`;
  
  console.log(`🤖 [Agent]: Targeting environment: ${BASE_URL}`);

  try {
    let response = await fetch(PROTECTED_RESOURCE, { method: "POST" });
    
    if (response.status === 402) {
      const paywallData = await response.json();
      console.log(`⚠️  [Agent]: Hit a 402 Paywall! Instructions parsed:`, paywallData.payment_instructions);

      const invoiceAmount = paywallData.payment_instructions.amount;
      console.log(`💸 [Agent]: Auto-authorizing execution for ${invoiceAmount} USDC...`);

      console.log("📨 [Agent]: Initializing transaction tracking id...");
      const initResponse = await fetch(INITIALIZE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: invoiceAmount,
          email: "autonomous-agent-01@bot.network",
          metadata: {
            merchantName: "Dispatch Marketplace",
            currency: "USDC",
            chain: "Arbitrum"
          }
        })
      });

      const initResult = await initResponse.json();
      const uniqueReference = initResult.data.reference;
      console.log(`📌 [Agent]: Ledger reference generated: ${uniqueReference}`);
      console.log(`🔗 [Agent]: CCTP Routing Strategy Ready:`, initResult.data.cctp_routing);

      const mockTxHash = "0xSUCCESS";
      console.log(`⛓️  [Agent]: Submitting payment verification with txHash: ${mockTxHash}`);

      const verifyUrl = `${BASE_URL}/api/payments/verify/${uniqueReference}?txHash=${mockTxHash}`;
      const verifyResponse = await fetch(verifyUrl);
      const verifyResult = await verifyResponse.json();

      console.log(`🏁 [Agent]: Verification Response Status -> ${verifyResult.message}`);

      console.log("🔑 [Agent]: Re-requesting asset using payment reference authentication...");
      const finalResponse = await fetch(PROTECTED_RESOURCE, {
        method: "POST",
        headers: { "X-ArcFlare-Reference": uniqueReference }
      });

      const cleanPayload = await finalResponse.json();

      if (finalResponse.status === 200) {
        console.log("🔓 [Agent]: Access Granted! Unlocked Payload:", cleanPayload.data.secretPayload);
      } else {
        console.log(`❌ [Agent]: Access Denied! Gateway responded with error code (${finalResponse.status}):`, cleanPayload.message || cleanPayload.error);
      }

    } else {
      console.log("❌ Unexpected status code received:", response.status);
    }
  } catch (error) {
    console.error("❌ Execution Error: Could not reach the server.", error.message);
  }
}

runAgentTask();