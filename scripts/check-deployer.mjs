import { network } from "hardhat";

const { ethers } = await network.getOrCreate();
const [deployer] = await ethers.getSigners();

if (deployer === undefined) {
  throw new Error("No deployer signer available. Check that PRIVATE_KEY is set in .env.");
}

const address = await deployer.getAddress();
const balance = await ethers.provider.getBalance(address);
const chain = await ethers.provider.getNetwork();

console.log("Network :", chain.name ?? "unknown", `(chainId ${chain.chainId})`);
console.log("Deployer:", address);
console.log("Balance :", balance.toString(), "wei", `(${Number(balance) / 1e18} native)`);