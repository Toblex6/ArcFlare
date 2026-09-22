import { network } from "hardhat";

// ---------------------------------------------------------------------------
// ArcFlarePayroll deployment (Hardhat 3 + hardhat-ethers v4)
//
// Run (testnet):  npx hardhat run scripts/deploy-payroll.mjs --network arc-testnet
// Run (mainnet):  npx hardhat run scripts/deploy-payroll.mjs --network arc-mainnet
//   Mainnet deploys read ARC_MAINNET_RPC_URL + MAINNET_DEPLOYER_KEY (hardhat
//   "arc-mainnet" network), refuse any chain other than 5042, and REQUIRE
//   explicit PAYROLL_OWNER (production owner/multisig) + PAYROLL_RELAYER —
//   no deployer or JOB_ESCROW_RELAYER fallback on mainnet.
//
// Constructor args (from env, never hard-coded):
//   PAYROLL_OWNER   (optional — defaults to the deployer address)
//   PAYROLL_RELAYER (optional — defaults to JOB_ESCROW_RELAYER; the shared
//                    relayer EOA already used by job escrow and Telegram
//                    gas sponsorship — see jobEscrowClient.getRelayerSigner)
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
const chainId = chain.chainId;
const isMainnet = chainId === 5042n;
if (!isMainnet && chainId !== 5042002n) {
  throw new Error(
    `Refusing to deploy: connected to unexpected chainId ${chainId} (expected 5042002 testnet or 5042 mainnet). Check ARC_TESTNET_RPC / ARC_MAINNET_RPC_URL.`
  );
}
console.log("Target  :", isMainnet ? "Arc Mainnet (5042)" : "Arc Testnet (5042002)");

// MAINNET RULE: ownership is assigned DIRECTLY to the explicitly supplied
// production owner/multisig during deployment — never the hot deployment
// signer, not even transiently. Both roles are required on mainnet.
const owner = isMainnet
  ? requireEnvAddress("PAYROLL_OWNER", "production owner/multisig")
  : optionalEnvAddress("PAYROLL_OWNER", deployerAddress, "deployer address");
const relayer = isMainnet
  ? requireEnvAddress("PAYROLL_RELAYER", "production relayer")
  : optionalEnvAddress(
      "PAYROLL_RELAYER",
      process.env.JOB_ESCROW_RELAYER?.trim(),
      "JOB_ESCROW_RELAYER"
    );

console.log("Deploying ArcFlarePayroll ...");
console.log("  owner  :", owner);
console.log("  relayer:", relayer);

const Payroll = await ethers.getContractFactory("ArcFlarePayroll", deployer);
const payroll = await Payroll.deploy(owner, relayer);
await payroll.waitForDeployment();
const payrollAddress = await payroll.getAddress();
const receipt = await payroll.deploymentTransaction().wait(1);
console.log("ArcFlarePayroll:", payrollAddress, `(tx ${receipt.hash})`);
console.log("");

console.log("Deployment complete. Add to your environment:");
console.log(`PAYROLL_CONTRACT_ADDRESS=${payrollAddress}`);