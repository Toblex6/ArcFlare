// scripts/deposit-x402.cjs — FIXED
require("dotenv").config({ path: ".env" });
const { GatewayClient } = require("@circle-fin/x402-batching/client");

async function main() {
  console.log("🟢 Script started");

  const PRIVATE_KEY = process.env.EOA_PRIVATE_KEY;
  if (!PRIVATE_KEY) {
    console.error("❌ EOA_PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  console.log("🔑 Private key loaded");

  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: PRIVATE_KEY,
  });

  console.log("✅ GatewayClient created");

  // ── Check balances BEFORE deposit ──────────────────────────────────────────
  console.log("\n📊 Checking balances before deposit...");
  try {
    const balances = await client.getBalances();
    console.log(`   Wallet:  ${balances.wallet.formatted} USDC`);
    console.log(`   Gateway: ${balances.gateway.formattedAvailable} USDC available`);

    if (parseFloat(balances.wallet.formatted) < 1) {
      console.error("❌ Insufficient wallet balance. Fund at https://faucet.circle.com");
      process.exit(1);
    }
  } catch (e) {
    console.warn("⚠️  Could not check balances:", e.message);
  }

  // ── Deposit ────────────────────────────────────────────────────────────────
  console.log("\n📤 Depositing 1 USDC into Gateway...");
  const result = await client.deposit("1");

  console.log("✅ Deposit successful!");
  console.log(`   Approval TX:  ${result.approvalTxHash}`);
  console.log(`   Deposit TX:   ${result.depositTxHash}`);
  console.log(`   Amount:       ${result.formattedAmount} USDC`);
  console.log(`   Explorer: https://testnet.arcscan.app/tx/${result.depositTxHash}`);

  // ── Check balances AFTER deposit ───────────────────────────────────────────
  console.log("\n⏳ Waiting 10 seconds for finality...");
  await new Promise((r) => setTimeout(r, 10000));

  console.log("📊 Checking balances after deposit...");
  const balancesAfter = await client.getBalances();
  console.log(`   Wallet:  ${balancesAfter.wallet.formatted} USDC`);
  console.log(`   Gateway: ${balancesAfter.gateway.formattedAvailable} USDC available`);

  if (parseFloat(balancesAfter.gateway.formattedAvailable) > 0) {
    console.log("\n✅ Gateway funded. Ready to make x402 payments.");
    console.log("   Run: node scripts/pay-x402.cjs");
  } else {
    console.log("\n⏳ Gateway balance not yet reflected. Wait 30s and check again.");
  }
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.cause) console.error("   Cause:", err.cause);
  process.exit(1);
});
