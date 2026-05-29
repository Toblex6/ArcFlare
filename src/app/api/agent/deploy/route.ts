import { NextResponse } from "next/server";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

// On-chain identity registry address on Arc Testnet
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

export async function POST(request: Request) {
  try {
    // 1. Parse custom metadata from the frontend request body if provided
    const body = await request.json().catch(() => ({}));
    const metadataUri = body.metadataUri || "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
    const agentName = body.agentName || "ArcFlare Autonomous Agent";

    // 2. Initialize the Circle client securely on the server side
    const circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });

    // 3. Step 1: Create the wallet set container
    const walletSet = await circleClient.createWalletSet({
      name: `${agentName} Wallet Set`,
    });

    const walletSetId = walletSet.data?.walletSet?.id;
    if (!walletSetId) {
      return NextResponse.json({ error: "Failed to initialize Circle Wallet Set" }, { status: 500 });
    }

    // 4. Create the Owner and Validator SCA Wallets on Arc Testnet
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

    // 5. Step 2: Register agent identity via transaction execution
    const registerTx = await circleClient.createContractExecutionTransaction({
      walletAddress: ownerWallet.address!,
      blockchain: "ARC-TESTNET",
      contractAddress: IDENTITY_REGISTRY,
      abiFunctionSignature: "register(string)",
      abiParameters: [metadataUri],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txId = registerTx.data?.id;
    if (!txId) {
      return NextResponse.json({ error: "Identity registration transaction failed to initiate" }, { status: 500 });
    }

    // 6. Polling execution block to wait for deterministic completion
    let txHash: string | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000)); // 2-second ticks
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

    // 7. Step 3: Parse logs using Viem to extract the assigned Agent token ID
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(),
    });

    const latestBlock = await publicClient.getBlockNumber();
    
    // ✅ FIXED: Using explicit BigInt() constructor wrapper instead of native literals (500n, 0n)
    // This allows compilation under lower ES targets without throwing compilation blocks
    const searchWindow = BigInt(500);
    const fromBlock = latestBlock > searchWindow ? latestBlock - searchWindow : BigInt(0);

    const transferLogs = await publicClient.getLogs({
      address: IDENTITY_REGISTRY,
      event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
      args: { to: ownerWallet.address as `0x${string}` },
      fromBlock,
      toBlock: latestBlock,
    });

    const agentId = transferLogs.length > 0 
      ? transferLogs[transferLogs.length - 1].args.tokenId!.toString()
      : "Pending Indexing";

    // Return the payload back to your dashboard UI instantly
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
    console.error("API Error in ArcFlare deploy route:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}