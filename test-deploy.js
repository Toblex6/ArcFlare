// test-deploy.js
// Run this file using: node test-deploy.js
const { execSync } = require('child_process');

// Config settings — swap out localhost for your production Render URL when ready!
const TARGET_API_URL = "http://localhost:3000/api/agent/deploy"; 
const TEST_API_KEY = "your_generated_dev_api_key_here"; 

async function runVerificationTest() {
  console.log("🚀 Initiating ArcFlare Agent Deployment Security verification sequence...");

  const payload = JSON.stringify({
    agentName: "Siggy Alpha Agent-01",
    ownerNode: "0xbD3FAD84e7a41D222c7C36947B0A3B1592F42154", // Your verified developer wallet address
    metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei"
  });

  try {
    console.log("📡 Sending provision payload via secure pipeline...");
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TEST_API_KEY
      },
      body: payload
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`❌ Deployment Rejected [Status: ${response.status}]:`, data);
      return;
    }

    console.log("\n===============================================");
    console.log("🎉 SUCCESS: AGENT PROVISIONED SECURELY ON-CHAIN");
    console.log("===============================================");
    console.log(`🤖 Agent Name:   ${data.agent?.name}`);
    console.log(`🆔 ERC-8004 ID:  ${data.agent?.tokenId}`);
    console.log(`💳 Owner SCA:    ${data.wallets?.owner}`);
    console.log(`🛡️ Validator:    ${data.wallets?.validator}`);
    console.log(`⛓️ Arc Tx Hash:  ${data.txHash}`);
    console.log(`🌐 Explorer:     ${data.explorerUrl}`);
    console.log("===============================================\n");

  } catch (error) {
    console.error("💥 Critical execution breakdown encountered during routine test:", error);
  }
}

runVerificationTest();