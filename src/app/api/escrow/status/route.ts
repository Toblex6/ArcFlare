// src/app/api/escrow/status/route.ts
// Returns status of a specific escrow by reference.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";

async function statusHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const reference = searchParams.get("reference");

    if (!reference) {
      return NextResponse.json(
        { success: false, error: "reference query param is required." },
        { status: 400 }
      );
    }

    const escrow = await (prisma as any).escrow.findUnique({
      where: { reference },
    });

    if (!escrow) {
      return NextResponse.json(
        { success: false, error: "Escrow not found." },
        { status: 404 }
      );
    }

    const now = new Date();
    const isExpired = escrow.deadline && new Date(escrow.deadline) < now;

    return NextResponse.json({
      success: true,
      escrow: {
        ...escrow,
        isExpired,
        timeRemaining: isExpired
          ? 0
          : Math.floor((new Date(escrow.deadline).getTime() - now.getTime()) / 1000),
        explorerUrl: escrow.txHash
          ? `https://testnet.arcscan.app/tx/${escrow.txHash}`
          : null,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export const GET = withApiKey(statusHandler);