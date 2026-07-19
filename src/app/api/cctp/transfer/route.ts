// src/app/api/cctp/transfer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { transferCctpV2, CCTP_SOURCE_CHAINS, CCTP_DEST_CHAINS } from "@/lib/cctp-v2";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fromChain, toChain, amount, recipient } = body;

    if (!fromChain || !toChain || !amount || !recipient) {
      return NextResponse.json(
        { success: false, error: "Missing fields: fromChain, toChain, amount, recipient" },
        { status: 400 }
      );
    }

    // Validate source chain
    const sourceExists = CCTP_SOURCE_CHAINS.some((c) => c.id === fromChain);
    if (!sourceExists) {
      return NextResponse.json(
        { success: false, error: `Unsupported source chain: ${fromChain}` },
        { status: 400 }
      );
    }

    // Validate destination chain (only "arc" is allowed)
    const destExists = CCTP_DEST_CHAINS.some((c) => c.id === toChain);
    if (!destExists) {
      return NextResponse.json(
        { success: false, error: `Unsupported destination chain: ${toChain}` },
        { status: 400 }
      );
    }

    const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
    if (!privateKey) {
      return NextResponse.json(
        { success: false, error: "Private key not configured" },
        { status: 500 }
      );
    }

    const result = await transferCctpV2({
      fromChain,
      toChain,
      amount,
      recipient,
      privateKey,
    });

    return NextResponse.json({
      success: true,
      sourceTxHash: result.sourceTxHash,
      destinationTxHash: result.destinationTxHash,
    });
  } catch (error: any) {
    console.error("[CCTP API]", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    sourceChains: CCTP_SOURCE_CHAINS.map((c) => ({
      id: c.id,
      label: c.label,
      testnet: c.testnet,
    })),
    destinationChains: CCTP_DEST_CHAINS.map((c) => ({
      id: c.id,
      label: c.label,
      testnet: c.testnet,
    })),
  });
}