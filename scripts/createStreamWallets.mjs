// scripts/createStreamWallets.mjs
// Run with: node scripts/createStreamWallets.mjs

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { randomUUID } from "crypto"; // built-in Node.js — no install needed

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

async function main() {
  // ── Step 1: Create wallet set ──────────────────────────────────────────
  console.log("🔧 Creating ArcFlare wallet set...");

  const wsRes = await client.createWalletSet({
    idempotencyKey: randomUUID(),
    name: "ArcFlare Agent Wallets",
  });

  const walletSetId = wsRes.data?.walletSet?.id;
  if (!walletSetId) {
    console.error("❌ Failed to create wallet set:");
    console.error(JSON.stringify(wsRes, null, 2));
    process.exit(1);
  }
  console.log(`✅ Wallet set created: ${walletSetId}`);

  // ── Step 2: Create 2 wallets ───────────────────────────────────────────
  console.log("🔧 Creating 2 SCA wallets on ARC-TESTNET...");

  const walletsRes = await client.createWallets({
    idempotencyKey: randomUUID(),
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 2,
  });

  const wallets = walletsRes.data?.wallets;
  if (!wallets || wallets.length < 2) {
    console.error("❌ Failed to create wallets:");
    console.error(JSON.stringify(walletsRes, null, 2));
    process.exit(1);
  }

  const sender   = wallets[0];
  const receiver = wallets[1];

  console.log("\n==============================================");
  console.log("✅ WALLETS CREATED SUCCESSFULLY");
  console.log("==============================================");
  console.log(`\n📤 SENDER WALLET`);
  console.log(`   Address:   ${sender.address}`);
  console.log(`   Wallet ID: ${sender.id}`);
  console.log(`\n📥 RECEIVER WALLET`);
  console.log(`   Address:   ${receiver.address}`);
  console.log(`   Wallet ID: ${receiver.id}`);
  console.log("\n==============================================");
  console.log("📋 YOUR STREAM CURL (ready to copy):");
  console.log("==============================================");
  console.log(`
curl -X POST https://arcflare-gateway.onrender.com/api/payments/stream \\
  -H "x-api-key: arc_live_fa8d822ac7713302ea287a183a15cacdbfcb5d1a5477fae2" \\
  -H "Content-Type: application/json" \\
  -d '{
    "senderSCA": "${sender.address}",
    "receiverSCA": "${receiver.address}",
    "ratePerSecond": "0.001",
    "totalDeposited": "0.01"
  }'
  `);

  console.log("⚠️  BEFORE RUNNING THE CURL ABOVE:");
  console.log("   1. Go to https://faucet.circle.com");
  console.log("   2. Select network: ARC-TESTNET");
  console.log("   3. Select token: USDC");
  console.log(`   4. Paste sender address: ${sender.address}`);
  console.log("   5. Click request — then run the curl above\n");
}

main().catch((err) => {
  console.error("❌ Error:", err.message || err);
  process.exit(1);
});
