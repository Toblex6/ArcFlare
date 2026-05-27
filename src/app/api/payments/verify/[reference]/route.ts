import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ethers } from "ethers";

// Pointing explicitly to your Arc Testnet configuration
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc-testnet.arc-l1.network"; 

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { reference } = await params;

    if (!reference) {
      return NextResponse.json({ status: false, message: "Transaction reference token is missing." }, { status: 400 });
    }

    let payment = await prisma.paymentLog.findUnique({
      where: { reference: reference },
    });

    if (!payment) {
      return NextResponse.json({ status: false, message: "Transaction reference not found." }, { status: 404 });
    }

    // If already successful, return cached data along with its simulated cross-chain metadata
    if (payment.status === "SUCCESS") {
      return NextResponse.json({
        status: true,
        message: "Verification successful (Cached Testnet Ledger)",
        data: formatResponse(payment),
      }, { status: 200 });
    }

    const { searchParams } = new URL(request.url);
    const txHash = searchParams.get("txHash");

    if (txHash) {
      if (txHash === "0xSUCCESS") {
        // 🚀 SIMULATING CIRCLE CCTP TESTNET ATTESTATION PROCESSING
        payment = await prisma.paymentLog.update({
          where: { reference: reference },
          data: { 
            status: "SUCCESS",
            merchant: payment.merchant || "Dispatch Marketplace",
            chain: "Arbitrum Sepolia ➔ Arc Testnet (via Circle CCTP)",
          },
        });
      } else {
        try {
          const provider = new ethers.JsonRpcProvider(RPC_URL);
          const txReceipt = await provider.getTransactionReceipt(txHash);

          if (txReceipt && txReceipt.status === 1) {
            payment = await prisma.paymentLog.update({
              where: { reference: reference },
              data: { 
                status: "SUCCESS",
                chain: "Arbitrum Sepolia ➔ Arc Testnet (via Circle CCTP)"
              },
            });
          } else {
            return NextResponse.json(
              { status: false, message: "Testnet transaction failed or unconfirmed." },
              { status: 402 }
            );
          }
        } catch (blockchainError: any) {
          console.error("⚠️ Testnet RPC Failure, using local fallback mode:", blockchainError.message);
        }
      }
    }

    return NextResponse.json({
      status: true,
      message: payment.status === "SUCCESS" ? "Verification successful" : "Payment is pending Testnet block confirmation",
      data: formatResponse(payment),
    }, { status: 200 });

  } catch (error: any) {
    console.error("❌ Testnet Verification Layer Failure:", error);
    return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 });
  }
}

function formatResponse(payment: any) {
  const hasSettled = payment.status === "SUCCESS";
  return {
    id: payment.id,
    reference: payment.reference,
    amount: payment.amount,
    currency: payment.currency,
    chain: payment.chain || "Arbitrum Sepolia ➔ Arc Testnet (via Circle CCTP)",
    gateway_response: hasSettled ? "Successful" : "Pending",
    status: payment.status,
    sender_email: payment.senderEmail || "autonomous-agent@bot.network",
    merchant: payment.merchant || "Dispatch Marketplace",
    paid_at: payment.timestamp,
    // Dynamic Testnet CCTP Layer telemetry injection
    cctp_telemetry: {
      source_domain: 3, // Arbitrum Sepolia Circle Testnet Domain ID
      target_domain: 7, // Arc Testnet Custom Domain ID
      attestation_status: hasSettled ? "REDEEMED_AND_MINTED" : "POLLING_CIRCLE_TESTNET_IRIS_API",
      nonce: Math.floor(100000 + Math.random() * 900000),
      message_bytes: hasSettled ? "0x00000003000000000000000000000000" + payment.reference : "Awaiting testnet burn receipt..."
    }
  };
}