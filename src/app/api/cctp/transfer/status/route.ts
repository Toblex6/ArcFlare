// src/app/api/cctp/transfer/status/route.ts
// Poll this after POST /api/cctp/transfer returns { status: "pending" }.
// Checks the bridge without source signing; legacy testnet mint recovery only.

import { NextRequest, NextResponse } from "next/server";
import { checkBridgeStatus, findStep } from "@/lib/cctp-v2";
import { cctpUnavailableResponse } from "@/lib/bridge/cctpAvailability";
import { explorerTxUrl } from "@/lib/config/network";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const reference = searchParams.get("reference");

        if (!reference) {
            return NextResponse.json(
                { success: false, error: "reference query param is required." },
                { status: 400 }
            );
        }

        const tracked = await checkBridgeStatus(reference);
        if (!tracked) {
            return NextResponse.json(
                { success: false, error: "No bridge found for that reference (it may have already completed, or the server restarted)." },
                { status: 404 }
            );
        }

        if (tracked.status === 'submitting') {
            return NextResponse.json({ success: true, state: 'submitting' });
        }

        if (tracked.status === 'error') {
            return NextResponse.json({ success: true, state: 'error', error: tracked.message });
        }

        // tracked.status === 'settled' — tracked.result is a real BridgeResult
        const { result } = tracked;
        const burnStep = findStep(result, 'Burn');
        const mintStep = findStep(result, 'Mint');

        // Bridge Kit doesn't always populate step.explorerUrl until the step is
        // fully finalized — fall back to building the Arc explorer link
        // ourselves from the tx hash if we have one but no ready-made URL yet.
        const destinationExplorerUrl =
            mintStep?.explorerUrl || (mintStep?.txHash ? `${explorerTxUrl(mintStep.txHash)}` : undefined);

        return NextResponse.json({
            success: true,
            state: result.state, // 'pending' | 'success' | 'error'
            amount: result.amount,
            sourceExplorerUrl: burnStep?.explorerUrl,
            destinationExplorerUrl,
            error: result.state === 'error' ? mintStep?.errorMessage || burnStep?.errorMessage : undefined,
        });
    } catch (error: any) {
        const unavailable = cctpUnavailableResponse(error);
        if (unavailable) return unavailable;
        console.error("[CCTP Bridge status]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
