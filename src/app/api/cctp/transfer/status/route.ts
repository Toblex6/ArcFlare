// src/app/api/cctp/transfer/status/route.ts
// Poll this after POST /api/cctp/transfer returns { status: "pending" }.
// Read-only lookup against Circle's attestation service — no wallet client
// needed, so it's cheap to call every few seconds from the frontend.

import { NextRequest, NextResponse } from "next/server";
import { getCctpTransferStatus, CCTP_SOURCE_CHAINS } from "@/lib/cctp-v2";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const sourceTxHash = searchParams.get("sourceTxHash");
        const fromChain = searchParams.get("fromChain");

        if (!sourceTxHash || !fromChain) {
            return NextResponse.json(
                { success: false, error: "sourceTxHash and fromChain query params are required." },
                { status: 400 }
            );
        }

        const sourceExists = CCTP_SOURCE_CHAINS.some((c) => c.id === fromChain);
        if (!sourceExists) {
            return NextResponse.json(
                { success: false, error: `Unsupported source chain: ${fromChain}` },
                { status: 400 }
            );
        }

        const status = await getCctpTransferStatus({
            sourceTxHash: sourceTxHash as `0x${string}`,
            fromChain,
        });

        return NextResponse.json({ success: true, ...status });
    } catch (error: any) {
        console.error("[CCTP status]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
