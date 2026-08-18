import { network } from "hardhat";

// ---------------------------------------------------------------------------
// ArcFlareSwapPool deployment (Hardhat 3 + hardhat-ethers v4)
//
// Run:  npx hardhat run scripts/deploy-swap-pool.mjs --network arc-testnet
//
// Constructor args (both verified on-chain 2026-08-16 against Arc testnet
// RPC — name/symbol/decimals checked directly, see supportedTokens.ts):
//   tokenA = USDC 0x3600…0000 (6 decimals)
//   tokenB = EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a (6 decimals)
// ---------------------------------------------------------------------------

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

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

console.log("Deploying ArcFlareSwapPool ...");
console.log("  tokenA (USDC):", USDC);
console.log("  tokenB (EURC):", EURC);

const SwapPool = await ethers.getContractFactory("ArcFlareSwapPool", deployer);
const pool = await SwapPool.deploy(USDC, EURC);
await pool.waitForDeployment();
const poolAddress = await pool.getAddress();
const receipt = await pool.deploymentTransaction().wait(1);
console.log("ArcFlareSwapPool:", poolAddress, `(tx ${receipt.hash})`);
console.log("");

console.log("Deployment complete. Add to your environment:");
console.log(`SWAP_POOL_CONTRACT_ADDRESS=${poolAddress}`);
