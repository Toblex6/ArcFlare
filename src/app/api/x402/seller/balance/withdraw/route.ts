// src/app/api/x402/seller/withdraw/route.ts
//
// Seller Gateway withdrawal — using GatewayClient.withdraw() exactly per
// the confirmed real pattern from circlefin/arc-nanopayments:
//
//   const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: SELLER_PRIVATE_KEY });
//   const result = await gateway.withdraw(amount, { chain: destinationChain, recipient });
//
// Supports same-chain (instant) and cross-chain withdrawals, per SDK docs.
//
// SECURITY (2026-08-19): destinationAddress is no longer a free-form input.
// This wallet is the settlement pool for ALL x402 revenue (marketplace,
// brain, nano), so withdrawals are restricted to an env-configured treasury
// allowlist:
//   SELLER_GATEWAY_TREASURY_ADDRESSES  comma-separated 0x addresses.
// If the allowlist is NOT configured, the only permitted recipient is the
// seller's own EOA (SELLER_PRIVATE_KEY's address) — funds stay under the
// gateway's own signer. Either way, an ApiKey holder can never route pooled
// gateway funds to an arbitrary address.

import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

async function withdrawHandler(request: Request) {
  try {
    const { amount, destinationChain, destinationAddress } = await request.json();

    const sellerPrivateKey = process.env.SELLER_PRIVATE_KEY;
    if (!sellerPrivateKey) {
      return NextResponse.json({ success: false, error: "SELLER_PRIVATE_KEY not configured." }, { status: 500 });
    }

    if (!amount) {
      return NextResponse.json({ success: false, error: "amount is required." }, { status: 400 });
    }

    const sellerAddress = privateKeyToAccount(sellerPrivateKey as `0x${string}`).address.toLowerCase();
    const treasuryAllowlist = (process.env.SELLER_GATEWAY_TREASURY_ADDRESSES || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);

    let recipient: `0x${string}` | undefined;
    if (destinationAddress) {
      const dest = destinationAddress.toLowerCase();
      const allowed =
        treasuryAllowlist.length > 0
          ? treasuryAllowlist.includes(dest)
          : dest === sellerAddress;
      if (!allowed) {
        return NextResponse.json(
          {
            success: false,
            error: treasuryAllowlist.length
              ? "destinationAddress is not on the SELLER_GATEWAY_TREASURY_ADDRESSES allowlist."
              : "destinationAddress is not allowed — configure SELLER_GATEWAY_TREASURY_ADDRESSES, or omit destinationAddress to withdraw to the seller's own address.",
          },
          { status: 403 }
        );
      }
      recipient = destinationAddress as `0x${string}`;
    } else if (treasuryAllowlist.length === 1) {
      recipient = treasuryAllowlist[0] as `0x${string}`;
    }

    const gateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: sellerPrivateKey as `0x${string}`,
    });

    const result = await gateway.withdraw(amount.toString(), {
      chain: destinationChain || "arcTestnet",
      recipient,
    });

    return NextResponse.json({
      success: true,
      txHash: result.mintTxHash,
      amount: result.formattedAmount,
      sourceChain: result.sourceChain,
      destinationChain: result.destinationChain,
      recipient: result.recipient,
      status: "confirmed",
      explorerUrl: `https://testnet.arcscan.app/tx/${result.mintTxHash}`,
    });
  } catch (error: any) {
    console.error("❌ Gateway withdraw error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(withdrawHandler);