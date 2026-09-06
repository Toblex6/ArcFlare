// src/app/api/consumer/balance/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { getTokenBalance } from "@/src/lib/wallet/tokenBalance";

export async function GET(req: NextRequest) {
    try {
        const walletAddress = await resolveConsumerSession(req);
        if (!walletAddress) {
            return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
        }

        // Multicurrency Phase 2B: the caller names which supported token
        // balance it needs (?currency=USDC|EURC, default USDC for legacy
        // callers). Unsupported symbols are rejected — never silently
        // substituted with the other token's balance.
        const { searchParams } = new URL(req.url);
        const requested = (searchParams.get("currency") ?? "USDC").trim().toUpperCase();
        if (requested !== "USDC" && requested !== "EURC") {
            return NextResponse.json(
                { success: false, error: `Unsupported currency: "${requested}". Supported: USDC, EURC.` },
                { status: 400 }
            );
        }

        const result = await getTokenBalance(walletAddress, requested);

        return NextResponse.json({
            success: true,
            balance: String(result.balance),
            currency: result.currency,
            token: {
                symbol: result.currency,
                address: result.address,
                decimals: result.decimals,
            },
            walletAddress,
        });
    } catch (error: any) {
        console.error("[consumer/balance]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}