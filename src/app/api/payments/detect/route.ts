// src/app/api/payments/detect/route.ts
// Manually trigger CCTP V2 cross-chain detection for a specific burn tx hash.
// Used by agents self-reporting a burn tx or for manual testing.

import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { pollForAttestation, mintOnArc, getChainName } from "@/src/lib/cctp";
import { withApiKey } from "@/src/lib/middleware/withApiKey";

async function detectHandler(request: Request) {
  try {
    const { messageHash, amount, currency, sourceDomain, webhookUrl } =
      await request.json();

    if (!messageHash) {
      return NextResponse.json(
        {
          success: false,
          error:
            "messageHash is required — pass the keccak256 hash of the " +
            "CCTP V2 MessageSent event bytes from the source chain burn tx.",
        },
        { status: 400 }
      );
    }

    const reference = `arc_detect_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const sourceChain = getChainName(sourceDomain ?? 3);

    // Record detection in ledger
    await prisma.paymentLog.create({
      data: {
        reference,
        amount: parseFloat(amount) || 0,
        currency: currency || "USDC",
        chain: `${sourceChain} → Arc Testnet (via CCTP V2)`,
        senderEmail: "cross-chain-detect@arc.network",
        merchant: "ArcFlare CCTP V2 Router",
        status: "POLLING_CIRCLE_TESTNET_IRIS_API",
        webhookUrl: webhookUrl || null,
      },
    });

    // Poll Circle Iris V2 API
    let arcTxHash: string;
    try {
      const { message, attestation } = await pollForAttestation(messageHash);
      arcTxHash = await mintOnArc(message, attestation);
    } catch (cctpErr: any) {
      await prisma.paymentLog.update({
        where: { reference },
        data: { status: "ATTESTATION_FAILED" },
      });
      return NextResponse.json(
        {
          success: false,
          error: cctpErr.message,
          reference,
          hint: "The burn tx may still be confirming. Retry in 30 seconds.",
        },
        { status: 502 }
      );
    }

    // Mark settled
    const settled = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: "REDEEMED_AND_MINTED",
        arcTxHash,
        chain: `${sourceChain} → Arc Testnet (via CCTP V2)`,
      },
    });

    // Fire webhook
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payment.detected_and_settled",
          reference,
          arcTxHash,
          amount: settled.amount,
          currency: settled.currency,
          sourceChain,
          status: "SUCCESS",
          settledAt: new Date().toISOString(),
          settlementType: "CCTP_V2_MANUAL_DETECT",
          explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      reference,
      arcTxHash,
      sourceChain,
      settlementType: "CCTP_V2_MANUAL_DETECT",
      explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
      message: `USDC auto-routed from ${sourceChain} to Arc Testnet via CCTP V2.`,
    });
  } catch (error: any) {
    console.error("Detect route error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const POST = withApiKey(detectHandler);
