// src/app/api/consumer/balance/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";

const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export async function GET(req: NextRequest) {
    try {
        const walletAddress = await resolveConsumerSession(req);
        if (!walletAddress) {
            return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
        }

        const usdcAddress = process.env.ARC_USDC_ADDRESS;
        if (!usdcAddress || !process.env.ARC_TESTNET_RPC) {
            return NextResponse.json(
                { success: false, error: "Arc RPC/USDC address not configured." },
                { status: 500 }
            );
        }

        const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC);
        const usdc = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider);
        const raw = await usdc.balanceOf(walletAddress);

        return NextResponse.json({
            success: true,
            balance: ethers.formatUnits(raw, 6), // USDC = 6 decimals
            walletAddress,
        });
    } catch (error: any) {
        console.error("[consumer/balance]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
