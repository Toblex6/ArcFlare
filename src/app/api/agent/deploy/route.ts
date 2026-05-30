import { NextResponse } from "next/server";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

// Use environment variable with a fallback for local testing
const IDENTITY_REGISTRY = process.env.IDENTITY_REGISTRY_ADDRESS || "0x8004A818BFB912233c491871b3d84c89A494BD9e";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const metadataUri = body.metadataUri || "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
    const agentName = body.agentName || "ArcFlare Autonomous Agent";

    // 1. Initialize Circle Client
    const circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });

    // 2. Provision Wallet Set
    const walletSet = await circleClient.createWalletSet({
      name: `${agentName} Wallet Set`,
    });

    const walletSetId = walletSet.data?.walletSet?.id;
    if (!walletSetId) {
      return NextResponse.json({ error: "Failed to initialize Circle Wallet Set" }, { status: 500 });
    }

    // 3. Create SCA Wallets
    const walletsResponse = await circleClient.createWallets({
      blockchains: ["ARC-TESTNET"],
      count: 2,
      walletSetId: walletSetId,
      accountType: "SCA",
    });

    const ownerWallet = walletsResponse.data?.wallets?.[0];
    const validatorWallet = walletsResponse.data?.wallets?.[1];

    if (!ownerWallet || !validatorWallet) {
      return NextResponse.json({ error: "Failed to provision SCA wallets" }, { status: 500 });
    }

    // 4. Register identity via Contract Execution
    const registerTx = await circleClient.createContractExecutionTransaction({
      walletAddress: ownerWallet.address!,
      blockchain: "ARC-TESTNET",
      contractAddress: IDENTITY_REGISTRY as `0x${string}`,
      abiFunctionSignature: "register(string)",
      abiParameters: [metadataUri],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txId = registerTx.data?.id;
    if (!txId) {
      return NextResponse.json({ error: "Identity registration failed to initiate" }, { status: 500 });
    }

    // 5. Polling for Completion
    let txHash: string | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2500)); 
      const { data } = await circleClient.getTransaction({ id: txId });
      
      if (data?.transaction?.state === "COMPLETE") {
        txHash = data.transaction.txHash;
        break;
      }
      if (data?.transaction?.state === "FAILED") {
        return NextResponse.json({ error: "On-chain registration reverted" }, { status: 502 });
      }
    }

    if (!txHash) {
      return NextResponse.json({ error: "Transaction polling timed out" }, { status: 408 });
    }

    // 6. Indexing via Viem (Robust log search)
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(),
    });

    const latestBlock = await publicClient.getBlockNumber();
    const searchWindow = BigInt(500);
    const fromBlock = latestBlock > searchWindow ? latestBlock - searchWindow : BigInt(0);

    const transferLogs = await publicClient.getLogs({
      address: IDENTITY_REGISTRY as `0x${string}`,
      event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
      args: { to: ownerWallet.address as `0x${string}` },
      fromBlock,
      toBlock: latestBlock,
    });

    // Extract Token ID with fallback
    const agentId = transferLogs.length > 0 
      ? transferLogs[transferLogs.length - 1].args.tokenId!.toString()
      : "PENDING_INDEX";

    return NextResponse.json({
      success: true,
      agentId,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      wallets: {
        owner: ownerWallet.address,
        validator: validatorWallet.address,
      }
    });

  } catch (error: any) {
    console.error("❌ API Error [ArcFlare Deploy]:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}