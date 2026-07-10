// scripts/agent/setup.ts
// Step 1: Run this ONCE to create owner + validator wallets and register
// the ArcFlare AI agent on ERC-8004. After running, save the output
// (agent ID, wallet addresses) to your .env file.
//
// Run: npx tsx --env-file=.env scripts/agent/setup.ts

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  http,
  parseAbiItem,
  getContract,
  keccak256,
  toHex,
} from "viem";
import { arcTestnet } from "viem/chains";

// ── Confirmed ERC-8004 registry addresses from Arc docs ──────────────────────
const IDENTITY_REGISTRY   = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";

const AGENT_METADATA_URI =
  process.env.AGENT_METADATA_URI ||
  "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

async function waitForCircleTx(txId: string, label: string) {
  process.stdout.write(`  Waiting for ${label}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await circleClient.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE") {
      const hash = data.transaction.txHash;
      console.log(` ✓\n  Explorer: https://testnet.arcscan.app/tx/${hash}`);
      return hash!;
    }
    if (data?.transaction?.state === "FAILED") throw new Error(`${label} failed`);
    process.stdout.write(".");
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  console.log("\n═══════════════════════════════════════");
  console.log("   ArcFlare AI Agent Setup (ERC-8004)");
  console.log("═══════════════════════════════════════\n");

  // ── Step 1: Create owner + validator wallets ────────────────────────────────
  console.log("── Step 1: Creating wallets ──");

  const walletSet = await circleClient.createWalletSet({
    name: "ArcFlare Agent Wallets",
  });

  const walletsResponse = await circleClient.createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 2,
    walletSetId: walletSet.data?.walletSet?.id ?? "",
    accountType: "SCA",
  });

  const ownerWallet = walletsResponse.data?.wallets?.[0]!;
  const validatorWallet = walletsResponse.data?.wallets?.[1]!;

  console.log(`  Owner wallet:     ${ownerWallet.address} (${ownerWallet.id})`);
  console.log(`  Validator wallet: ${validatorWallet.address} (${validatorWallet.id})`);

  // ── Step 2: Register agent identity ────────────────────────────────────────
  console.log("\n── Step 2: Registering agent identity on ERC-8004 ──");
  console.log(`  Metadata: ${AGENT_METADATA_URI}`);

  const registerTx = await circleClient.createContractExecutionTransaction({
    walletAddress: ownerWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: "register(string)",
    abiParameters: [AGENT_METADATA_URI],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  await waitForCircleTx(registerTx.data?.id!, "identity registration");

  // ── Step 3: Get the agent token ID ─────────────────────────────────────────
  console.log("\n── Step 3: Retrieving agent ID ──");

  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = latestBlock > 10000n ? latestBlock - 10000n : 0n;

  const transferLogs = await publicClient.getLogs({
    address: IDENTITY_REGISTRY,
    event: parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
    ),
    args: { to: ownerWallet.address as `0x${string}` },
    fromBlock,
    toBlock: latestBlock,
  });

  if (transferLogs.length === 0) throw new Error("No Transfer event found");

  const agentId = transferLogs[transferLogs.length - 1].args.tokenId!.toString();

  const identityContract = getContract({
    address: IDENTITY_REGISTRY,
    abi: [
      { name: "ownerOf",  type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
      { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
    ],
    client: publicClient,
  });

  const owner    = await identityContract.read.ownerOf([BigInt(agentId)]);
  const tokenURI = await identityContract.read.tokenURI([BigInt(agentId)]);

  console.log(`  Agent ID:     ${agentId}`);
  console.log(`  Owner:        ${owner}`);
  console.log(`  Metadata URI: ${tokenURI}`);

  // ── Step 4: Record initial reputation (from validator, not owner) ──────────
  console.log("\n── Step 4: Recording initial reputation ──");

  const tag = "agent_deployed";
  const feedbackHash = keccak256(toHex(tag));

  const reputationTx = await circleClient.createContractExecutionTransaction({
    walletAddress: validatorWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: REPUTATION_REGISTRY,
    abiFunctionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    abiParameters: [agentId, "80", "0", tag, "", "", "", feedbackHash],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  await waitForCircleTx(reputationTx.data?.id!, "reputation recording");

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("   Setup Complete — Save these values:");
  console.log("═══════════════════════════════════════");
  console.log(`\nAGENT_TOKEN_ID=${agentId}`);
  console.log(`AGENT_OWNER_WALLET_ADDRESS=${ownerWallet.address}`);
  console.log(`AGENT_OWNER_WALLET_ID=${ownerWallet.id}`);
  console.log(`AGENT_VALIDATOR_WALLET_ADDRESS=${validatorWallet.address}`);
  console.log(`AGENT_VALIDATOR_WALLET_ID=${validatorWallet.id}`);
  console.log(`\nExplorer: https://testnet.arcscan.app/address/${ownerWallet.address}\n`);
}

main().catch((e) => { console.error("\nSetup failed:", e.message); process.exit(1); });