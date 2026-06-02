// src/app/api/webhooks/circle/route.ts
// Receives Circle V2 webhook events and automatically routes
// detected USDC transfers to Arc via CCTP V2.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  pollForAttestation,
  mintOnArc,
  verifyCircleWebhookSignature,
  getChainName,
} from "@/lib/cctp";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    // Empty ping check
    if (!rawBody || rawBody.trim() === "") {
      console.log("ℹ️ Empty ping received.");
      return NextResponse.json({ success: true, message: "Ping accepted" });
    }

    // ── Verify Circle V2 webhook signature ───────────────────────────────
    const signature = req.headers.get("x-circle-signature");
    const isValid = verifyCircleWebhookSignature(rawBody, signature);

    if (!isValid) {
      console.warn("⚠️ Webhook signature mismatch — possible spoofed request.");
      // Uncomment for production strict mode:
      // return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 200 });
    }

    const eventType = body?.type || body?.notificationType;
    console.log(`🎯 Circle V2 Webhook Event: ${eventType}`);

    // ── Subscription handshake ────────────────────────────────────────────
    if (eventType === "subscription.created") {
      console.log("✅ Circle V2 subscription handshake confirmed.");
      return NextResponse.json({ success: true, message: "Handshake Complete" });
    }

    // ── CCTP V2: Transfer detected on source chain ────────────────────────
    // Fires when USDC burn is detected on Arbitrum, Base, Ethereum etc.
    if (
      eventType === "transfers.updated" ||
      eventType === "gateway.deposit.finalized"
    ) {
      const transfer = body?.data?.transfer || body?.data;
      const messageHash = transfer?.transactionHash || transfer?.sourceTxHash;
      const sourceDomain = transfer?.sourceDomain ?? transfer?.source?.domain;
      const amount = transfer?.amount?.amount || transfer?.amount || "0";
      const currency = transfer?.amount?.currency || "USDC";

      console.log(
        `💰 CCTP V2 transfer detected — ${amount} ${currency} from ${getChainName(sourceDomain)}`
      );

      if (messageHash) {
        const reference = `arc_auto_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        // Log detection
        try {
          await prisma.paymentLog.create({
            data: {
              reference,
              amount: parseFloat(amount) || 0,
              currency,
              chain: `${getChainName(sourceDomain)} → Arc Testnet (via CCTP V2)`,
              senderEmail: transfer?.walletId || "auto-detected@arc.network",
              merchant: "ArcFlare Auto-Router",
              status: "POLLING_CIRCLE_TESTNET_IRIS_API",
            },
          });
        } catch (dbErr: any) {
          console.warn("DB log skipped:", dbErr.message);
        }

        // Auto-settle in background — returns fast to Circle
        autoSettleV2(reference, messageHash).catch((err) =>
          console.error("CCTP V2 auto-settle failed:", err.message)
        );
      }
    }

    // ── CCTP V2: Mint finalized on Arc ────────────────────────────────────
    if (eventType === "gateway.mint.finalized") {
      const data = body?.data;
      const arcTxHash = data?.transactionHash;
      const reference = data?.metadata?.reference;

      console.log(`🪙 CCTP V2 mint finalized on Arc! Tx: ${arcTxHash}`);

      if (reference && arcTxHash) {
        try {
          const updated = await prisma.paymentLog.update({
            where: { reference },
            data: { status: "REDEEMED_AND_MINTED", arcTxHash },
          });

          if (updated.webhookUrl) {
            fetch(updated.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "payment.settled",
                reference,
                amount: updated.amount,
                currency: updated.currency,
                arcTxHash,
                status: "SUCCESS",
                settledAt: new Date().toISOString(),
                settlementType: "CCTP_V2_AUTO_ROUTED",
                explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
              }),
            }).catch(() => {});
          }
        } catch (err: any) {
          console.warn("Mint record update failed:", err.message);
        }
      }
    }

    // ── CCTP V2: Routing forwarded ────────────────────────────────────────
    if (eventType === "gateway.mint.forwarded") {
      console.log("🚀 CCTP V2 routing forwarded — settlement in progress.");
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("🚨 Webhook error:", error.message);
    return NextResponse.json(
      { success: false, error: "Internal processing failed safely" },
      { status: 200 }
    );
  }
}

// ─── Background: Auto-settle via CCTP V2 ─────────────────────────────────────
async function autoSettleV2(reference: string, messageHash: string) {
  try {
    console.log(`⚡ CCTP V2 auto-settling ${reference}...`);

    const { message, attestation } = await pollForAttestation(messageHash);
    const arcTxHash = await mintOnArc(message, attestation);

    const settled = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: "REDEEMED_AND_MINTED",
        arcTxHash,
        chain: "Auto-Routed → Arc Testnet (via CCTP V2)",
      },
    });

    console.log(`✅ CCTP V2 auto-settled! Arc tx: ${arcTxHash}`);

    if (settled.webhookUrl) {
      fetch(settled.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payment.auto_settled",
          reference,
          arcTxHash,
          amount: settled.amount,
          currency: settled.currency,
          status: "SUCCESS",
          settledAt: new Date().toISOString(),
          settlementType: "CCTP_V2_AUTO_ROUTED",
          explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
        }),
      }).catch(() => {});
    }
  } catch (err: any) {
    console.error(`❌ CCTP V2 auto-settle failed for ${reference}:`, err.message);
    await prisma.paymentLog
      .update({
        where: { reference },
        data: { status: "ATTESTATION_FAILED" },
      })
      .catch(() => {});
  }
}