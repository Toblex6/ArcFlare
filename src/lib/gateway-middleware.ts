// src/lib/gateway-middleware.ts
// Circle Gateway Nanopayments — x402 middleware wrapper for ArcFlare endpoints

import { NextRequest, NextResponse } from "next/server";

const ARC_TESTNET_CHAIN = "eip155:5042002";
const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

export interface GatewayPaymentContext {
  payer: string;
  amount: string;
  network: string;
  transaction?: string;
}

interface RequirePaymentOptions {
  sellerAddress: string;
  priceUSDC: string;
}

export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  return async function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    const paymentSignature = req.headers.get("payment-signature");

    // ── No payment provided — return 402 with payment requirements ──────────
    if (!paymentSignature) {
      return NextResponse.json(
        {
          error: "Payment Required",
          accepts: [
            {
              scheme: "GatewayWalletBatched",
              network: ARC_TESTNET_CHAIN,
              maxAmountRequired: priceToAtomicUnits(options.priceUSDC),
              resource: req.nextUrl.pathname,
              payTo: options.sellerAddress,
              asset: "USDC",
              facilitator: FACILITATOR_URL,
              // ✅ EIP-712 domain parameters — required for signing
              domain: {
                name: "ArcFlare",
                version: "1.0.0",
                chainId: 5042002,
              },
            },
          ],
        },
        { status: 402 }
      );
    }

    // ── Verify the payment signature ──────────────────────────────────────────
    try {
      const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentSignature,
          sellerAddress: options.sellerAddress,
          network: ARC_TESTNET_CHAIN,
          maxAmountRequired: priceToAtomicUnits(options.priceUSDC),
          resource: req.nextUrl.pathname,
        }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok || !verifyData.valid) {
        return NextResponse.json(
          { error: "Invalid or expired payment signature.", details: verifyData },
          { status: 402 }
        );
      }

      // ── Queue for Gateway batch settlement ──────────────────────────────────
      const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentSignature, sellerAddress: options.sellerAddress }),
      });

      const settleData = await settleRes.json();

      const paymentContext: GatewayPaymentContext = {
        payer: verifyData.payer,
        amount: priceToAtomicUnits(options.priceUSDC),
        network: ARC_TESTNET_CHAIN,
        transaction: settleData.transaction,
      };

      return await handler(req, paymentContext);
    } catch (error: any) {
      console.error("Gateway payment verification error:", error);
      return NextResponse.json(
        { error: "Payment verification failed.", message: error.message },
        { status: 500 }
      );
    }
  };
}

function priceToAtomicUnits(priceUSDC: string): string {
  return Math.round(parseFloat(priceUSDC) * 1_000_000).toString();
}