// src/app/api/x402/eoa-wallet/me/route.ts
// Returns the calling merchant's own x402 buyer wallet address + Gateway
// balance, auto-provisioning the wallet if they don't have one yet. Never
// returns the private key.

import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getOrCreateBuyerWallet } from "@/lib/x402-wallet";
import { isGatewayAvailable, requireGatewayChain, gatewayUnavailableBody } from "@/lib/x402-gateway";

export async function GET(req: NextRequest) {
    try {
        // Mainnet fail-closed (Option B): Gateway balances are not
        // available on Arc Mainnet yet.
        if (!isGatewayAvailable()) {
            return NextResponse.json(gatewayUnavailableBody(), { status: 503 });
        }
        const merchant = await resolveMerchant(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
        }

        const wallet = await getOrCreateBuyerWallet(merchant.id);

        let gatewayBalance = "0";
        let walletBalance = "0";
        try {
            const client = new GatewayClient({ chain: requireGatewayChain(), privateKey: wallet.privateKey });
            const balances = await client.getBalances();
            gatewayBalance = balances?.gateway?.formattedAvailable ?? "0";
            walletBalance = balances?.wallet?.formatted ?? "0";
        } catch (e: any) {
            console.warn("[eoa-wallet/me] Could not fetch balance:", e.message);
        }

        return NextResponse.json({
            success: true,
            address: wallet.address,
            gatewayBalance,
            walletBalance,
        });
    } catch (error: any) {
        console.error("[eoa-wallet/me] Error:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
