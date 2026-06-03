// src/app/api/escrow/release/route.ts
// Releases escrowed USDC to beneficiary when conditions are met.
// Called by depositor confirming delivery, or admin releasing directly.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || "";

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
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === "COMPLETE" && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === "FAILED") {
      throw new Error("Release transaction failed onchain.");
    }
  }
  throw new Error("Release transaction timed out.");
}

async function releaseHandler(request: Request) {
  try {
    const { reference, callerSCA, callerWalletId } = await request.json();

    if (!reference || !callerSCA) {
      return NextResponse.json(
        { success: false, error: "reference and callerSCA are required." },
        { status: 400 }
      );
    }

    // Fetch escrow from DB
    const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
    if (!escrow) {
      return NextResponse.json({ success: false, error: "Escrow not found." }, { status: 404 });
    }
    if (escrow.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: `Escrow is ${escrow.status} — cannot release.` },
        { status: 400 }
      );
    }

    const circleClient = getCircleClient();

    // ── Step 1: Confirm delivery from caller's SCA ────────────────────────
    // This calls confirmDelivery() on the escrow contract
    // If both parties confirm, contract auto-releases
    const confirmTx = await circleClient.createContractExecutionTransaction({
      walletAddress: callerSCA,
      blockchain: "ARC-TESTNET" as any,
      contractAddress: ESCROW_CONTRACT,
      abiFunctionSignature: "confirmDelivery(bytes32)",
      abiParameters: [escrow.onchainId || reference],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txHash = await waitForCircleTx(circleClient, confirmTx.data?.id!);
    console.log(`✅ Delivery confirmed by ${callerSCA}. Tx: ${txHash}`);

    // ── Step 2: Update DB status ──────────────────────────────────────────
    const isDepositor = callerSCA.toLowerCase() === escrow.depositorSCA.toLowerCase();
    const isBeneficiary = callerSCA.toLowerCase() === escrow.beneficiarySCA.toLowerCase();

    let newStatus = escrow.status;
    let depositorConfirmed = escrow.depositorConfirmed || isDepositor;
    let beneficiaryConfirmed = escrow.beneficiaryConfirmed || isBeneficiary;

    // If both confirmed — mark as RELEASED
    if (depositorConfirmed && beneficiaryConfirmed) {
      newStatus = "RELEASED";
    }

    const updated = await (prisma as any).escrow.update({
      where: { reference },
      data: {
        status: newStatus,
        depositorConfirmed,
        beneficiaryConfirmed,
        releaseTxHash: newStatus === "RELEASED" ? txHash : null,
      },
    });

    // Fire webhook on full release
    if (newStatus === "RELEASED" && escrow.webhookUrl) {
      fetch(escrow.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "escrow.released",
          reference,
          amount: escrow.amount,
          currency: escrow.currency,
          beneficiary: escrow.beneficiarySCA,
          txHash,
          releasedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      escrow: updated,
      txHash,
      released: newStatus === "RELEASED",
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message:
        newStatus === "RELEASED"
          ? `Escrow fully released — ${escrow.amount} USDC sent to ${escrow.beneficiarySCA}`
          : `Delivery confirmed by ${isDepositor ? "depositor" : "beneficiary"} — waiting for other party.`,
    });
  } catch (error: any) {
    console.error("Escrow release error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(releaseHandler);