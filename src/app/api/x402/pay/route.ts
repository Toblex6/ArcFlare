// src/app/api/x402/pay/route.ts
//
// Resolves the caller's own x402 buyer wallet (one per merchant, auto-provisioned,
// key encrypted at rest — see src/lib/x402-wallet.ts) instead of paying from a
// single global BUYER_PRIVATE_KEY. Falls back to the legacy global key only for
// calls authenticated purely via an internal service ApiKey with no merchant
// identity attached (agent-to-agent calls) — there's no merchant to own a wallet
// in that case, so per-merchant wallets don't apply.

import { NextRequest, NextResponse } from "next/server";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { withApiKeyOrMerchant, resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { getOrCreateBuyerWallet } from "@/lib/x402-wallet";

async function x402PayHandler(req: NextRequest) {
  try {
    const { resourceUrl, body } = await req.json();

    if (!resourceUrl) {
      return NextResponse.json(
        { success: false, error: "Missing resourceUrl" },
        { status: 400 }
      );
    }

    // resourceUrl can arrive as a bare relative path (e.g. "/api/agent/brain")
    // for internal, same-deployment resources — GatewayClient.pay() needs an
    // absolute URL though, so resolve it against this deployment's own origin
    // when it isn't already absolute. External marketplace resourceUrls (full
    // https:// URLs) pass through unchanged.
    const resolvedResourceUrl = /^https?:\/\//i.test(resourceUrl)
      ? resourceUrl
      : new URL(resourceUrl, req.nextUrl.origin).toString();

    const merchant = await resolveMerchant(req);

    let PRIVATE_KEY: `0x${string}`;
    let payerAddress: string;

    if (merchant) {
      const wallet = await getOrCreateBuyerWallet(merchant.id);
      PRIVATE_KEY = wallet.privateKey;
      payerAddress = wallet.address;
    } else {
      // Internal service-key call with no merchant identity — legacy global wallet.
      const legacyKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
      if (!legacyKey) {
        return NextResponse.json(
          { success: false, error: "No merchant identity resolved and BUYER_PRIVATE_KEY not set for internal calls." },
          { status: 500 }
        );
      }
      PRIVATE_KEY = legacyKey;
      payerAddress = process.env.BUYER_ADDRESS || "unknown";
    }

    console.log(`[x402 pay] Paying: ${resolvedResourceUrl}`);
    console.log(`[x402 pay] Buyer: ${payerAddress}${merchant ? ` (merchant ${merchant.id})` : " (internal service key)"}`);

    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: PRIVATE_KEY,
    });

    // Check Gateway balance before paying
    let balances: any;
    try {
      balances = await client.getBalances();
      const available = balances?.gateway?.formattedAvailable ?? "0";
      console.log(`[x402 pay] Gateway balance: ${available} USDC`);
      if (parseFloat(available) <= 0) {
        return NextResponse.json({
          success: false,
          error: `No Gateway balance for ${payerAddress}. Fund this address via /api/x402/eoa-wallet/deposit first.`,
          buyerAddress: payerAddress,
          walletBalance: balances?.wallet?.formatted ?? "0",
          gatewayBalance: "0",
        }, { status: 400 });
      }
    } catch (balErr: any) {
      console.warn("[x402 pay] Could not check balance:", balErr.message);
    }

    const response = await client.pay(resolvedResourceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || JSON.stringify({}),
    });
    console.log(`[x402 pay] Success! TX: ${response.transaction}`);

    // response.data is now the marketplace proxy's envelope (paymentStatus/
    // upstreamOk/error/data) for marketplace-routed payments — pass it
    // through as-is rather than assuming its shape, since this route also
    // serves non-marketplace x402 resources that return plain data.
    return NextResponse.json({
      success: true,
      transaction: response.transaction,
      amountUSDC: response.formattedAmount,
      paidWith: payerAddress,
      resourceData: response.data,
    });
  } catch (error: any) {
    console.error("[x402 pay] Error:", error.message);
    if (error.cause) console.error("[x402 pay] Cause:", error.cause);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
export const POST = withApiKeyOrMerchant(x402PayHandler);