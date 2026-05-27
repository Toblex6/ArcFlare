import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ethers } from "ethers";

// Fallback provider URL for Arc-L1 or relevant EVM network
const RPC_URL = process.env.ARC_RPC_URL || "https://rpc.arc-l1.network"; 

/**
 * GET Handler for Payment Verification (Paystack-style architectural verification)
 * Endpoint: /api/payments/verify/[reference]
 * Optional Query Param: ?txHash=0x...
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    // 1. Resolve parameters natively for Next.js App Router context
    const { reference } = await params;

    if (!reference) {
      return NextResponse.json(
        { status: false, message: "Transaction reference token is missing." },
        { status: 400 }
      );
    }

    // 2. Query the paymentLog table using the unique reference string
    let payment = await prisma.paymentLog.findUnique({
      where: {
        reference: reference,
      },
    });

    if (!payment) {
      return NextResponse.json(
        { status: false, message: "Transaction reference not found." },
        { status: 404 }
      );
    }

    // 3. If it's already marked as SUCCESS in our database ledger, return early
    if (payment.status === "SUCCESS") {
      return NextResponse.json(
        {
          status: true,
          message: "Verification successful (Cached Ledger)",
          data: formatResponse(payment),
        },
        { status: 200 }
      );
    }

    // 4. Extract txHash directly from the URL query parameters
    const { searchParams } = new URL(request.url);
    const txHash = searchParams.get("txHash");

    if (txHash) {
      // 👇 DEVELOPMENT TEST BYPASS SIGNATURE
      if (txHash === "0xSUCCESS") {
        payment = await prisma.paymentLog.update({
          where: { reference: reference },
          data: { status: "SUCCESS" },
        });
      } else {
        // LIVE BLOCKCHAIN RESOLUTION PIPELINE
        try {
          // Connect to the Arc network provider via ethers.js
          const provider = new ethers.JsonRpcProvider(RPC_URL);
          const txReceipt = await provider.getTransactionReceipt(txHash);

          // Check if the transaction is fully confirmed and successful on-chain (status === 1)
          if (txReceipt && txReceipt.status === 1) {
            // Atomically update the database ledger state to SUCCESS
            payment = await prisma.paymentLog.update({
              where: { reference: reference },
              data: { status: "SUCCESS" },
            });
          } else {
            return NextResponse.json(
              { 
                status: false, 
                message: "On-chain transaction failed or is still unconfirmed by the network." 
              },
              { status: 402 } // HTTP 402 Payment Required
            );
          }
        } catch (blockchainError: any) {
          console.error("⚠️ RPC Provider Connection Failure:", blockchainError.message);
          // Fall back gracefully to returning the current PENDING database state if RPC fails
        }
      }
    }

    // 5. Return the current verified database payload state back to the caller
    return NextResponse.json(
      {
        status: true,
        message: payment.status === "SUCCESS" ? "Verification successful" : "Payment is pending on-chain confirmation",
        data: formatResponse(payment),
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error("❌ Verification Layer Failure:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * Data transformation formatting helper to structure the Paystack-style API response
 */
function formatResponse(payment: any) {
  return {
    id: payment.id,
    reference: payment.reference,
    amount: payment.amount,
    currency: payment.currency,
    chain: payment.chain,
    gateway_response: payment.status === "SUCCESS" ? "Successful" : "Pending",
    status: payment.status,
    sender_email: payment.senderEmail,
    merchant: payment.merchant,
    paid_at: payment.timestamp,
  };
}