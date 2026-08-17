import { network } from "hardhat";

// ---------------------------------------------------------------------------
// ArcFlare testnet deployment script (Hardhat 3 + hardhat-ethers v4)
//
// Run:  npx hardhat run scripts/deploy-arcflare.mjs --network arc-testnet
//
// Deploys, in order:
//   1. ArcFlareSpendLimit   (no constructor arguments)
//   2. ArcFlareJobEscrow    (owner, arbiter, treasurySink, relayer)
//
// Constructor addresses are read from the environment (never hard-coded):
//   JOB_ESCROW_OWNER         (optional — defaults to the deployer address)
//   JOB_ESCROW_ARBITER       (required)
//   JOB_ESCROW_TREASURY_SINK (required)
//   JOB_ESCROW_RELAYER       (required)
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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

// ---- ArcFlareJobEscrow constructor arguments (from env) ----
const owner = process.env.JOB_ESCROW_OWNER?.trim() ?? deployerAddress;
const arbiter = requireEnvAddress("JOB_ESCROW_ARBITER", "arbiter");
const treasurySink = requireEnvAddress("JOB_ESCROW_TREASURY_SINK", "treasury sink");
const relayer = requireEnvAddress("JOB_ESCROW_RELAYER", "relayer");

// ---- 1. ArcFlareSpendLimit (no constructor args) ----
console.log("Deploying ArcFlareSpendLimit ...");
const SpendLimit = await ethers.getContractFactory("ArcFlareSpendLimit", deployer);
const spendLimit = await SpendLimit.deploy();
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