// scripts/deploy-stream.mjs
//
// ArcFlareStream deployment (Hardhat 3 + hardhat-ethers v4).
// No constructor args — the contract starts with no owner/relayer: the
// poster of each stream is the only authority over it.
//
// Run:  npx hardhat run scripts/deploy-stream.mjs --network arc-testnet

import { network } from "hardhat";

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

console.log("Deploying ArcFlareStream ...");
const Stream = await ethers.getContractFactory("ArcFlareStream", deployer);
const stream = await Stream.deploy();
await stream.waitForDeployment();
const streamAddress = await stream.getAddress();
const receipt = await stream.deploymentTransaction().wait(1);
console.log("ArcFlareStream:", streamAddress, `(tx ${receipt.hash})`);
console.log("");

console.log("Deployment complete. Add to BOTH env files:");
console.log(`ARC_FLARE_STREAM_CONTRACT_ADDRESS=${streamAddress}`);