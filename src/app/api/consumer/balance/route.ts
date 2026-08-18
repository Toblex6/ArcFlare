// src/app/api/consumer/balance/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { getUsdcBalance } from "@/src/lib/wallet/usdcBalance";

export async function GET(req: NextRequest) {
    try {
        const walletAddress = await resolveConsumerSession(req);
        if (!walletAddress) {
            return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
        }

        const balance = await getUsdcBalance(walletAddress);

        return NextResponse.json({
            success: true,
            balance,
            walletAddress,
        });
    } catch (error: any) {
        console.error("[consumer/balance]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}