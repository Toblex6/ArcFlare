import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic"; // Opt out of static caching to ensure real-time telemetry

export async function GET() {
  try {
    // 1. Fetch all raw transaction logs from the live database sorted by creation date
    const paymentLogs = await prisma.paymentLog.findMany({
      orderBy: {
        timestamp: "desc",
      },
    });

    // 2. Compute dynamic aggregate pipeline analytics
    const totalVolume = paymentLogs
      .filter((log) => log.status === "SUCCESS")
      .reduce((accum, current) => accum + current.amount, 0);

    const successfulCount = paymentLogs.filter((log) => log.status === "SUCCESS").length;
    const successRate = paymentLogs.length > 0 ? (successfulCount / paymentLogs.length) * 100 : 100;

    // 3. Construct structured CCTP simulation payload extensions for client rendering
    const formattedPayments = paymentLogs.map((log) => {
      const isConfirmed = log.status === "SUCCESS";
      return {
        id: log.id,
        reference: log.reference,
        amount: log.amount,
        currency: log.currency || "USDC",
        chain: log.chain || "Arbitrum Sepolia ➔ Arc Testnet (via Circle CCTP)",
        status: log.status,
        sender_email: log.senderEmail || "autonomous-agent@bot.network",
        merchant: log.merchant || "Dispatch Marketplace",
        paid_at: log.timestamp,
        cctp_telemetry: {
          source_domain: 3,
          target_domain: 7,
          attestation_status: isConfirmed ? "REDEEMED_AND_MINTED" : "POLLING_CIRCLE_TESTNET_IRIS_API",
          nonce: Math.floor(100000 + Math.random() * 800000),
        },
      };
    });

    return NextResponse.json({
      status: true,
      metrics: {
        totalVolume,
        successRate,
        totalTransactions: paymentLogs.length,
      },
      data: formattedPayments,
    });
  } catch (error: any) {
    console.error("❌ Bulk Metrics Ledger Read Exception:", error);
    return NextResponse.json(
      { status: false, error: "Failed to pull transaction ledger matrix data", details: error.message },
      { status: 500 }
    );
  }
}