// src/app/api/escrow/create/route.ts
// Creates a trustless escrow on Arc Testnet using Circle SCA wallet
// and the ArcFlareEscrow contract. Funds locked in smart contract.

import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { withApiKey } from "@/src/lib/middleware/withApiKey";
import {
  initiateDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, parseUnits, encodeFunctionData } from "viem";
import { arcTestnet } from "viem/chains";

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || "";
const USDC_ARC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const ESCROW_ABI = [
  {
    name: "createEscrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "beneficiary", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadlineSeconds", type: "uint256" },
      { name: "reference", type: "string" },
    ],
    outputs: [{ name: "escrowId", type: "bytes32" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string,
  maxAttempts = 30
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === "FAILED") {
      throw new Error("Circle transaction failed onchain.");
    }
  }
  throw new Error("Circle transaction polling timed out.");
}

async function createEscrowHandler(request: Request) {
  try {
    const {
      depositorSCA,      // Circle SCA wallet address of depositor
      depositorWalletId, // Circle wallet ID of depositor
      beneficiarySCA,    // Recipient SCA wallet address
      amount,            // USDC amount as string e.g. "1.00"
      deadlineHours,     // Hours until escrow expires e.g. 24
      condition,         // Human readable condition e.g. "Deliver API data"
      webhookUrl,
    } = await request.json();

    if (!depositorSCA || !depositorWalletId || !beneficiarySCA || !amount) {
      return NextResponse.json(
        { success: false, error: "depositorSCA, depositorWalletId, beneficiarySCA and amount are required." },
        { status: 400 }
      );
    }

    if (!ESCROW_CONTRACT) {
      return NextResponse.json(
        { success: false, error: "ARCFLARE_ESCROW_CONTRACT_ADDRESS not set in environment." },
        { status: 500 }
      );
    }

    const circleClient = getCircleClient();
    const reference = `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const amountWei = parseUnits(amount.toString(), 6); // USDC has 6 decimals
    const deadlineTimestamp = Math.floor(Date.now() / 1000) + (deadlineHours || 24) * 3600;

    // ── Step 1: Approve escrow contract to spend USDC ─────────────────────
    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress: depositorSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ESCROW_CONTRACT, amountWei.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    await waitForCircleTx(circleClient, approveTx.data?.id!);
    console.log("✅ USDC approval confirmed");

    // ── Step 2: Create escrow on Arc ──────────────────────────────────────
    const escrowTx = await circleClient.createContractExecutionTransaction({
      walletAddress: depositorSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: ESCROW_CONTRACT,
      abiFunctionSignature: "createEscrow(address,uint256,uint256,string)",
      abiParameters: [
        beneficiarySCA,
        amountWei.toString(),
        deadlineTimestamp.toString(),
        reference,
      ],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const escrowTxHash = await waitForCircleTx(circleClient, escrowTx.data?.id!);
    console.log(`✅ Escrow created on Arc. Tx: ${escrowTxHash}`);

    // ── Step 3: Save to Prisma ────────────────────────────────────────────
    const escrowRecord = await (prisma as any).escrow.create({
      data: {
        reference,
        amount: parseFloat(amount),
        currency: "USDC",
        depositorSCA,
        beneficiarySCA,
        contractAddress: ESCROW_CONTRACT,
        status: "ACTIVE",
        condition: condition || null,
        deadline: new Date(deadlineTimestamp * 1000),
        txHash: escrowTxHash,
        webhookUrl: webhookUrl || null,
      },
    });

    return NextResponse.json({
      success: true,
      escrow: escrowRecord,
      txHash: escrowTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${escrowTxHash}`,
      message: `Escrow created — ${amount} USDC locked in ArcFlareEscrow contract on Arc Testnet.`,
    });
  } catch (error: any) {
    console.error("Escrow create error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(createEscrowHandler);
