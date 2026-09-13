import { network } from "hardhat";

// ---------------------------------------------------------------------------
// ArcFlareSwapPool deployment (Hardhat 3 + hardhat-ethers v4)
//
// Run:  npx hardhat run scripts/deploy-swap-pool.mjs --network arc-testnet
//       npx hardhat run scripts/deploy-swap-pool.mjs --network arc-mainnet
//         (mainnet: requires SWAP_POOL_TOKEN_A + SWAP_POOL_TOKEN_B — never
//         inherits testnet values; see below)
//
// Constructor args: tokenA + tokenB (verified on-chain 2026-08-16 against
// Arc testnet RPC — name/symbol/decimals checked directly, see
// supportedTokens.ts):
//   testnet defaults: tokenA = USDC 0x3600…0000 (6 decimals)
//                     tokenB = EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
//   mainnet: NO addresses are known in this repo — set BOTH env vars below
//     explicitly from official Arc/Circle mainnet sources. NEVER copy testnet
//     values. The script refuses to deploy unless both are valid 0x addresses.
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function resolvePoolToken(envName, testnetDefault, label) {
  const raw = (process.env[envName] ?? "").trim();
  // Explicit value always wins (both networks) — lets testnet operators pin
  // a replacement pool pair without editing this script.
  if (raw) {
    if (!ADDRESS_RE.test(raw)) throw new Error(`${envName} is not a valid 0x address: ${raw}`);
    return raw;
  }
  // No override: testnet keeps its verified default; any other network
  // (in practice --network arc-mainnet) FAILS CLOSED instead of silently
  // deploying a testnet-pair pool on mainnet.
  const net = (process.env.ARC_NETWORK ?? "").trim().toLowerCase();
  if (net === "mainnet") {
    throw new Error(
      `${envName} is required for a mainnet deployment — no mainnet token addresses are published in this repo. ` +
        `Set ${envName} explicitly (and SWAP_POOL_TOKEN_B) from official mainnet sources; never copy testnet values.`
    );
  }
  console.log(`  ${envName} not set — using Arc Testnet ${label} default ${testnetDefault}`);
  return testnetDefault;
}

const USDC = resolvePoolToken("SWAP_POOL_TOKEN_A", "0x3600000000000000000000000000000000000000", "USDC");
const EURC = resolvePoolToken("SWAP_POOL_TOKEN_B", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", "EURC");

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
