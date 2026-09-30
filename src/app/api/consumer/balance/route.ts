// src/app/api/consumer/balance/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { getTokenBalance } from "@/src/lib/wallet/tokenBalance";
import { isTokenNotSupportedOnNetwork } from "@/src/lib/tokens/supportedTokens";

export async function GET(req: NextRequest) {
    try {
        const walletAddress = await resolveConsumerSession(req);
        if (!walletAddress) {
            return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
        }

        // Multicurrency Phase 2B: the caller names which supported token
        // balance it needs (?currency=USDC|EURC|CIRBTC, default USDC for
        // legacy callers). Unsupported symbols are rejected — never silently
        // substituted with the other token's balance.
        const { searchParams } = new URL(req.url);
        const requested = (searchParams.get("currency") ?? "USDC").trim().toUpperCase();
        if (requested !== "USDC" && requested !== "EURC" && requested !== "CIRBTC") {
            return NextResponse.json(
                { success: false, error: `Unsupported currency: "${requested}". Supported: USDC, EURC, CIRBTC.` },
                { status: 400 }
            );
        }

        let result;
        try {
            result = await getTokenBalance(walletAddress, requested);
        } catch (tokenError: any) {
            // A token with no configuration on this network is a clean
            // client-visible answer — never a 500. Genuine RPC/DB failures
            // fall through to the 500 below.
            if (isTokenNotSupportedOnNetwork(tokenError)) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `${requested} is not supported on this network.`,
                        code: "TOKEN_NOT_SUPPORTED_ON_NETWORK",
                        currency: requested,
                    },
                    { status: 400 }
                );
            }
            throw tokenError;
        }

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