import { NextResponse } from "next/server";
import { executeAgentPayment } from "@/services/agentPayService";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { merchantAddress, amountInUSDC, paymentReference } = body;

    if (!merchantAddress || !amountInUSDC || !paymentReference) {
      return NextResponse.json(
        { success: false, error: "Missing required agent payload fields." },
        { status: 400 }
      );
    }

    // Fire the async background sequence to establish the terminal handshake
    executeAgentPayment({ merchantAddress, amountInUSDC, paymentReference });

    return NextResponse.json({
      success: true,
      message: "ArcFlare Agent loop spawned. Check persistent connection log to approve."
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
