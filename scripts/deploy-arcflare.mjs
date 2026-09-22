import { network } from "hardhat";

// ---------------------------------------------------------------------------
// ArcFlare testnet deployment script (Hardhat 3 + hardhat-ethers v4)
//
// Run (testnet):  npx hardhat run scripts/deploy-arcflare.mjs --network arc-testnet
// Run (mainnet):  npx hardhat run scripts/deploy-arcflare.mjs --network arc-mainnet
//   Mainnet deploys read ARC_MAINNET_RPC_URL + MAINNET_DEPLOYER_KEY (hardhat
//   "arc-mainnet" network), refuse any chain other than 5042, and REQUIRE
//   JOB_ESCROW_OWNER to be the production owner/multisig — the deployment
//   signer is never assigned ownership, not even transiently.
//
// Deploys, in order:
//   1. ArcFlareSpendLimit   (owner, recorder)
//   2. ArcFlareJobEscrow    (owner, arbiter, treasurySink, relayer)
//
// Constructor addresses are read from the environment (never hard-coded):
//   JOB_ESCROW_OWNER         (optional — defaults to the deployer address)
//   JOB_ESCROW_ARBITER       (required)
//   JOB_ESCROW_TREASURY_SINK (required)
//   JOB_ESCROW_RELAYER       (required)
//   SPEND_LIMIT_OWNER        (optional — defaults to JOB_ESCROW_OWNER)
//   SPEND_LIMIT_RECORDER     (optional — defaults to JOB_ESCROW_RELAYER)
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function optionalEnvAddress(name, fallback, label) {
  const value = process.env[name]?.trim();
  if (value) {
    if (!ADDRESS_RE.test(value)) {
      throw new Error(`${name} is not a valid address: ${value}`);
    }
    return value;
  }
  if (!fallback) {
    throw new Error(`${name} is not set and no fallback is available (${label})`);
  }
  console.log(`  ${name} not set — using ${label} fallback`);
  return fallback;
}

function requireEnvAddress(name, label) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set — provide the ${label} address`);
  }
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
  return value;
}

const { ethers } = await network.getOrCreate();

const [deployer] = await ethers.getSigners();
if (deployer === undefined) {
  throw new Error("No deployer signer available — check that PRIVATE_KEY is set in .env");
}

const deployerAddress = await deployer.getAddress();
const balance = await ethers.provider.getBalance(deployerAddress);
const chain = await ethers.provider.getNetwork();

console.log("Network :", chain.name ?? "unknown", `(chainId ${chain.chainId})`);
console.log("Deployer:", deployerAddress);
console.log("Balance :", balance.toString(), `wei (${Number(balance) / 1e18} native)`);
console.log("");

if (balance === 0n) {
  throw new Error("Deployer has zero native balance — fund it before deploying");
}

// ---- Network guard: refuse to deploy against an unexpected chain ----
// Arc Testnet = 5042002, Arc Mainnet = 5042 (docs.arc.io/arc/references/rpc-endpoints).
// A wrong-chain deploy would strand the fresh contracts on the wrong network
// with roles assigned there — abort instead of guessing.
const chainId = chain.chainId;
const isMainnet = chainId === 5042n;
if (!isMainnet && chainId !== 5042002n) {
  throw new Error(
    `Refusing to deploy: connected to unexpected chainId ${chainId} (expected 5042002 testnet or 5042 mainnet). Check ARC_TESTNET_RPC / ARC_MAINNET_RPC_URL.`
  );
}
console.log("Target  :", isMainnet ? "Arc Mainnet (5042)" : "Arc Testnet (5042002)");

// ---- ArcFlareJobEscrow constructor arguments (from env) ----
// MAINNET RULE: ownership is assigned DIRECTLY to the explicitly supplied
// production owner/multisig during deployment. The temporary deployment signer
// (MAINNET_DEPLOYER_KEY) must NEVER be the final owner, not even transiently —
// so on mainnet JOB_ESCROW_OWNER is required and the deployer fallback is
// disabled. (Testnet keeps the deployer default for dev convenience.)
const owner = isMainnet
  ? requireEnvAddress("JOB_ESCROW_OWNER", "production owner/multisig")
  : (process.env.JOB_ESCROW_OWNER?.trim() || deployerAddress);
const arbiter = requireEnvAddress("JOB_ESCROW_ARBITER", "arbiter");
const treasurySink = requireEnvAddress("JOB_ESCROW_TREASURY_SINK", "treasury sink");
const relayer = requireEnvAddress("JOB_ESCROW_RELAYER", "relayer");

// ---- 1. ArcFlareSpendLimit (owner, recorder) ----
const spendLimitOwner = optionalEnvAddress("SPEND_LIMIT_OWNER", owner, "JOB_ESCROW_OWNER");
const spendLimitRecorder = optionalEnvAddress("SPEND_LIMIT_RECORDER", relayer, "JOB_ESCROW_RELAYER");
console.log("Deploying ArcFlareSpendLimit ...");
console.log("  owner   :", spendLimitOwner);
console.log("  recorder:", spendLimitRecorder);
const SpendLimit = await ethers.getContractFactory("ArcFlareSpendLimit", deployer);
const spendLimit = await SpendLimit.deploy(spendLimitOwner, spendLimitRecorder);
await spendLimit.waitForDeployment();
const spendLimitAddress = await spendLimit.getAddress();
const spendLimitReceipt = await spendLimit.deploymentTransaction().wait(1);
console.log("ArcFlareSpendLimit:", spendLimitAddress, `(tx ${spendLimitReceipt.hash})`);
console.log("");

// ---- 2. ArcFlareJobEscrow (owner, arbiter, treasurySink, relayer) ----
console.log("Deploying ArcFlareJobEscrow ...");
console.log("  owner       :", owner);
console.log("  arbiter     :", arbiter);
console.log("  treasurySink:", treasurySink);
console.log("  relayer     :", relayer);
const JobEscrow = await ethers.getContractFactory("ArcFlareJobEscrow", deployer);
const jobEscrow = await JobEscrow.deploy(owner, arbiter, treasurySink, relayer);
await jobEscrow.waitForDeployment();
const jobEscrowAddress = await jobEscrow.getAddress();
const jobEscrowReceipt = await jobEscrow.deploymentTransaction().wait(1);
console.log("ArcFlareJobEscrow:", jobEscrowAddress, `(tx ${jobEscrowReceipt.hash})`);
console.log("");

// ---- Summary + env lines ----
console.log("Deployment complete. Add these to your environment:");
console.log(`JOB_ESCROW_CONTRACT_ADDRESS=${jobEscrowAddress}`);
console.log(`SPEND_LIMIT_CONTRACT_ADDRESS=${spendLimitAddress}`);
console.log("");
console.log(
  "WARNING: do NOT set ARCFLARE_ESCROW_CONTRACT_ADDRESS to the ArcFlareJobEscrow address."
);
console.log(
  "ARCFLARE_ESCROW_CONTRACT_ADDRESS must point at the LEGACY escrow contract " +
    "(0xEb810aeD24D2314dB7471E44bf6DE89f017631E0 or 0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F on Arc Testnet) " +
    "that the payments/escrow routes call with an incompatible ABI (refundExpired etc). " +
    "Pointing it at ArcFlareJobEscrow makes every escrow route throw onchain ABI errors."
);