import { network } from "hardhat";

// ---------------------------------------------------------------------------
// ArcFlarePaymentRouter deployment (Hardhat 3 + hardhat-ethers v4)
//
// Run:  npx hardhat run scripts/deploy-payment-router.mjs --network arc-testnet
//       npx hardhat run scripts/deploy-payment-router.mjs --network arc-mainnet
//         (mainnet: requires ROUTER_TOKEN_A + ROUTER_TOKEN_B — never inherits
//         testnet values; see below)
//
// Binds the canonical pair + canonical pool immutably; the constructor itself
// cross-checks pool.tokenA()/tokenB() against the pair and reverts on mismatch.
//   testnet defaults: USDC 0x3600000000000000000000000000000000000000 (6 decimals)
//                     EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a (6 decimals)
//   POOL from SWAP_POOL_CONTRACT_ADDRESS
//   mainnet: NO addresses are known in this repo — set BOTH token env vars
//     explicitly from official Arc/Circle mainnet sources. NEVER copy testnet
//     values. The script refuses to deploy unless both are valid 0x addresses.
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function resolveRouterToken(envName, testnetDefault, label) {
  const raw = (process.env[envName] ?? "").trim();
  // Explicit value always wins (both networks).
  if (raw) {
    if (!ADDRESS_RE.test(raw)) throw new Error(`${envName} is not a valid 0x address: ${raw}`);
    return raw;
  }
  // No override: testnet keeps its verified default; a mainnet deploy FAILS
  // CLOSED instead of silently binding the testnet pair on mainnet.
  const net = (process.env.ARC_NETWORK ?? "").trim().toLowerCase();
  if (net === "mainnet") {
    throw new Error(
      `${envName} is required for a mainnet deployment — no mainnet token addresses are published in this repo. ` +
        `Set ${envName} explicitly (and ROUTER_TOKEN_B) from official mainnet sources; never copy testnet values.`
    );
  }
  console.log(`  ${envName} not set — using Arc Testnet ${label} default ${testnetDefault}`);
  return testnetDefault;
}

const USDC = resolveRouterToken("ROUTER_TOKEN_A", "0x3600000000000000000000000000000000000000", "USDC");
const EURC = resolveRouterToken("ROUTER_TOKEN_B", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", "EURC");

const { ethers } = await network.getOrCreate();

const [deployer] = await ethers.getSigners();
if (deployer === undefined) {
  throw new Error("No deployer signer available — check that PRIVATE_KEY is set in .env");
}

const poolAddr = (process.env.SWAP_POOL_CONTRACT_ADDRESS ?? "").trim();
if (!poolAddr) throw new Error("SWAP_POOL_CONTRACT_ADDRESS not set");

const deployerAddress = await deployer.getAddress();
const balance = await ethers.provider.getBalance(deployerAddress);
const chain = await ethers.provider.getNetwork();

console.log("Network :", chain.name ?? "unknown", `(chainId ${chain.chainId})`);
console.log("Deployer:", deployerAddress);
console.log("Balance :", balance.toString(), `wei (${Number(balance) / 1e18} native)`);
console.log("  USDC:", USDC);
console.log("  EURC:", EURC);
console.log("  POOL:", poolAddr);
console.log("");

if (balance === 0n) {
  throw new Error("Deployer has zero native balance — fund it before deploying");
}

// sanity: pool really is the canonical USDC/EURC pool before binding
const pool = await ethers.getContractAt("ArcFlareSwapPool", poolAddr, deployer);
const a = await pool.tokenA();
const b = await pool.tokenB();
console.log("Pool tokenA:", a);
console.log("Pool tokenB:", b);
const pairOk =
  (a.toLowerCase() === USDC.toLowerCase() && b.toLowerCase() === EURC.toLowerCase()) ||
  (a.toLowerCase() === EURC.toLowerCase() && b.toLowerCase() === USDC.toLowerCase());
if (!pairOk) throw new Error("pool is not the canonical USDC/EURC pool — refusing to bind router");
console.log("Pool pair check: OK");
console.log("");

console.log("Deploying ArcFlarePaymentRouter ...");
const Router = await ethers.getContractFactory("ArcFlarePaymentRouter", deployer);
const router = await Router.deploy(USDC, EURC, poolAddr);
await router.waitForDeployment();
const routerAddress = await router.getAddress();
const receipt = await router.deploymentTransaction().wait(1);
console.log("ArcFlarePaymentRouter:", routerAddress, `(tx ${receipt.hash})`);
console.log("");
console.log("Deployment complete. Add to your environment:");
console.log(`PAYMENT_ROUTER_CONTRACT_ADDRESS=${routerAddress}`);
