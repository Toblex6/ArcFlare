// src/app/api/payments/nano/settle/route.ts
// REAL onchain nano batch settlement
// Aggregates micro-payments and transfers real USDC on Arc Testnet

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  getUnsettledBalance,
  markBatchSettled,
  getUnsettledPairs,
  getBatchSummary,
  NANO_BATCH_THRESHOLD_USDC,
} from "@/lib/nanopayment";

const USDC_ARC = "0x3600000000000000000000000000000000000000";

// Default fallback payer for testnet demo
const DEFAULT_PAYER_SCA = "0x7a8214dad7630a7a39054e0121acdbc7a65821c9";
const DEFAULT_PAYER_WALLET_ID = "58ab0223-cad0-5128-896e-a88d6f217b43";

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string
): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    if (state === "COMPLETE" && data.transaction?.txHash) {
      return data.transaction.txHash;
    }
    if (state === "FAILED") {
      throw new Error("Nano batch settlement transaction failed onchain.");
    }
  }
  throw new Error("Nano settlement transaction timed out.");
}

// ── Settle one agent-merchant pair onchain ────────────────────────────────────
async function settleOnchain(
  agentSCA: string,
  merchantSCA: string,
  total: number,
  count: number,
  webhookUrl?: string
): Promise<{ batchRef: string; txHash: string; explorerUrl: string }> {
  const circleClient = getCircleClient();

  // Resolve payer wallet ID
  let payerWalletId = DEFAULT_PAYER_WALLET_ID;
  if (agentSCA !== DEFAULT_PAYER_SCA) {
    const agentRecord = await (prisma as any).agentRegistry.findFirst({
      where: { scaAddress: agentSCA },
    });
    if (agentRecord?.circleWalletId) {
      payerWalletId = agentRecord.circleWalletId;
    }
  }

  const amountStr = total.toFixed(6);
  const batchRef = `nano_onchain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  console.log(`💸 Settling nano batch: ${amountStr} USDC (${count} payments)`);
  console.log(`   From: ${agentSCA}`);
  console.log(`   To:   ${merchantSCA}`);

  // Transfer USDC from agent SCA to merchant SCA
  let txHash: string;

  try {
    // Try Circle native transfer first
    const transferTx = await circleClient.createTransaction({
      walletId: payerWalletId,
      blockchain: "ARC-TESTNET" as any,
      tokenAddress: USDC_ARC,
      destinationAddress: merchantSCA,
      amounts: [amountStr],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    } as any);

    if (!transferTx.data?.id) throw new Error("No transaction ID returned.");
    txHash = await waitForCircleTx(circleClient, transferTx.data.id);
  } catch (err: any) {
    console.warn("Native transfer failed, using ERC20 transfer:", err.message);

    // Fallback: ERC20 transfer
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(amountStr, 6);

    const erc20Tx = await circleClient.createContractExecutionTransaction({
      walletAddress: agentSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: USDC_ARC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [merchantSCA, amountWei.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    if (!erc20Tx.data?.id) throw new Error("No transaction ID returned.");
    txHash = await waitForCircleTx(circleClient, erc20Tx.data.id);
  }

  const explorerUrl = `https://testnet.arcscan.app/tx/${txHash}`;

  // Mark all nano payments settled
  await markBatchSettled(agentSCA, merchantSCA, batchRef);

  // Fire webhook
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "nano.batch_settled_onchain",
        batchRef,
        agentSCA,
        merchantSCA,
        totalSettled: total,
        paymentsCount: count,
        currency: "USDC",
        txHash,
        explorerUrl,
        settledAt: new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  console.log(`✅ Nano batch settled onchain. TxHash: ${txHash}`);

  return { batchRef, txHash, explorerUrl };
}

// ── POST /api/payments/nano/settle ────────────────────────────────────────────
async function settleNanoHandler(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    // ── Auto-settle ALL pairs mode ────────────────────────────────────────────
    if ((body as any).autoSettle) {
      const pairs = await getUnsettledPairs();
      const results = [];

      for (const pair of pairs) {
        const summary = await getBatchSummary(pair.agentSCA, pair.merchantSCA);
        if (!summary.shouldSettle) continue;

        try {
          const { batchRef, txHash, explorerUrl } = await settleOnchain(
            pair.agentSCA,
            pair.merchantSCA,
            summary.total,
            summary.count
          );
          results.push({
            agentSCA: pair.agentSCA,
            merchantSCA: pair.merchantSCA,
            totalSettled: summary.total,
            count: summary.count,
            batchRef,
            txHash,
            explorerUrl,
            success: true,
          });
        } catch (err: any) {
          results.push({
            agentSCA: pair.agentSCA,
            merchantSCA: pair.merchantSCA,
            success: false,
            error: err.message,
          });
        }
      }

      return NextResponse.json({
        success: true,
        settledPairs: results.filter((r) => r.success).length,
        failedPairs: results.filter((r) => !r.success).length,
        results,
        message: `Auto-settled ${results.filter((r) => r.success).length} pairs onchain on Arc Testnet.`,
      });
    }

    // ── Settle specific pair ──────────────────────────────────────────────────
    const { agentSCA, merchantSCA, webhookUrl, forceSettle } = body;

    if (!agentSCA || !merchantSCA) {
      return NextResponse.json(
        { success: false, error: "agentSCA and merchantSCA are required." },
        { status: 400 }
      );
    }

    const { total, count } = await getUnsettledBalance(agentSCA, merchantSCA);

    if (total <= 0) {
      return NextResponse.json(
        { success: false, error: "No unsettled nanopayments found." },
        { status: 400 }
      );
    }

    if (!forceSettle && total < NANO_BATCH_THRESHOLD_USDC) {
      return NextResponse.json(
        {
          success: false,
          error: `Batch not ready. ${total.toFixed(6)} USDC pending, threshold is ${NANO_BATCH_THRESHOLD_USDC} USDC. Pass forceSettle: true to override.`,
          unsettledBalance: total,
          unsettledCount: count,
          thresholdUSDC: NANO_BATCH_THRESHOLD_USDC,
        },
        { status: 400 }
      );
    }

    const { batchRef, txHash, explorerUrl } = await settleOnchain(
      agentSCA,
      merchantSCA,
      total,
      count,
      webhookUrl
    );

    return NextResponse.json({
      success: true,
      settlementType: "ONCHAIN_USDC_TRANSFER",
      batchRef,
      txHash,
      explorerUrl,
      totalSettled: parseFloat(total.toFixed(6)),
      paymentsCount: count,
      agentSCA,
      merchantSCA,
      message: `Nano batch settled onchain — ${count} payments totalling ${total.toFixed(6)} USDC transferred on Arc Testnet.`,
    });
  } catch (error: any) {
    console.error("❌ Nano settle error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        hint: error.message.includes("balance") || error.message.includes("insufficient")
          ? "Agent SCA needs USDC. Fund at https://faucet.circle.com — select ARC-TESTNET, paste agent SCA address."
          : undefined,
      },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(settleNanoHandler);