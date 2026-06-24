// src/app/api/consumer/wallet/route.ts
import { NextResponse } from "next/server";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

export async function POST() {
  try {
    const circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });

    const walletSet = await circleClient.createWalletSet({ name: "Consumer Wallet" });
    const wallets = await circleClient.createWallets({
      blockchains: ["ARC-TESTNET"],
      count: 1,
      walletSetId: walletSet.data?.walletSet?.id!,
      accountType: "SCA",
    });

    const address = wallets.data?.wallets?.[0]?.address;
    return NextResponse.json({ success: true, walletAddress: address });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}