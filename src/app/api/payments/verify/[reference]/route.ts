import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET Handler for Payment Verification (Paystack-style architectural verification)
 * Endpoint: /api/payments/verify/[reference]
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    // Resolve parameters natively for Next.js App Router context
    const { reference } = await params;

    if (!reference) {
      return NextResponse.json(
        { status: false, message: "Transaction reference token is missing." },
        { status: 400 }
      );
    }

    // Fix: Query the paymentLog table instead of the non-existent 'payment' table
    const payment = await prisma.paymentLog.findUnique({
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

    // Return the ledger payload back to the automated caller
    return NextResponse.json(
      {
        status: true,
        message: "Verification successful",
        data: {
          id: payment.id,
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          chain: payment.chain,
          gateway_response: "Successful",
          status: payment.status,
          sender_email: payment.senderEmail,
          merchant: payment.merchant,
          paid_at: payment.timestamp,
        },
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