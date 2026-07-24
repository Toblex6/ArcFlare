// src/app/api/cctp/transfer/status/route.ts
// Poll this after POST /api/cctp/transfer returns { status: "pending" }.
// Resumes/checks the bridge via Bridge Kit's own retry() mechanism.

import { NextRequest, NextResponse } from "next/server";
import { checkBridgeStatus, findStep } from "@/lib/cctp-v2";

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
            mintStep?.explorerUrl || (mintStep?.txHash ? `https://testnet.arcscan.app/tx/${mintStep.txHash}` : undefined);

        return NextResponse.json({
            success: true,
            state: result.state, // 'pending' | 'success' | 'error'
            amount: result.amount,
            sourceExplorerUrl: burnStep?.explorerUrl,
            destinationExplorerUrl,
            error: result.state === 'error' ? mintStep?.errorMessage || burnStep?.errorMessage : undefined,
        });
    } catch (error: any) {
        console.error("[CCTP Bridge status]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
